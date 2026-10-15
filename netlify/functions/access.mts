// Ledger access list (the Access tab). Admins and senior admins only, and
// only from a GHL sign-in (PIN sessions are capped at plain user).
//   GET  /api/access                   -> { users, seniors, requests, me }
//   GET  /api/access?ghl=1             -> { ghlUsers }  GHL location users not yet on the list
//   GET  /api/access?view=activity     -> { activity }  senior admins only
//   POST /api/access { action: "add", userId? | email?, name?, role? }
//        admins add users; only senior admins can add an admin
//   POST /api/access { action: "remove", id }
//        admins remove users; only senior admins remove admins; senior admins can't be removed
//   POST /api/access { action: "set-role", id, role: "admin" | "user" }   senior admins only
//   POST /api/access { action: "dismiss-request", id }

import { getStore } from "@netlify/blobs";
import {
  ACCESS_KEY,
  ACCESS_STORE,
  type AccessEntry,
  type AccessList,
  atLeast,
  clearAccessCache,
  isSenior,
  loadAccess,
  seniorKeys,
} from "../shared/auth.ts";
import { requireAuth, currentUser } from "./lib/auth-guard.mts";
import { listLocationUsers } from "./lib/ghl-sso.mts";
import { HttpError, transactBlobJSON, json } from "./lib/shared.mts";
import { logActivity, recentActivity } from "./lib/activity.mts";
import { REQUESTS_KEY, type AccessRequest } from "./session.mts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function view(u: AccessEntry) {
  return { ...u, role: isSenior(u) ? "senior" : u.role, pending: u.id.startsWith("email:") };
}

async function requests(): Promise<AccessRequest[]> {
  const data = (await getStore(ACCESS_STORE).get(REQUESTS_KEY, { type: "json" })) as AccessRequest[] | null;
  const list = await loadAccess({ fresh: true });
  // Drop anyone who has since been added.
  return (Array.isArray(data) ? data : []).filter(
    (r) => !list.users.some((u) => u.id === r.id || (!!u.email && u.email === r.email)) && !isSenior(r),
  );
}
async function dropRequest(match: { id?: string; email?: string }) {
  await transactBlobJSON<AccessRequest[]>(ACCESS_STORE, REQUESTS_KEY, [], (current) =>
    (Array.isArray(current) ? current : []).filter((r) => !(r.id === match.id || (!!match.email && r.email === match.email))),
  );
}
async function snapshot(req: Request) {
  const list = await loadAccess({ fresh: true });
  const me = currentUser(req)!;
  return {
    users: list.users.map(view).sort((a, b) => a.name.localeCompare(b.name)),
    seniors: seniorKeys(),
    requests: await requests(),
    me: { id: me.uid, role: me.effectiveRole },
  };
}

async function mutateList(fn: (users: AccessEntry[]) => AccessEntry[]) {
  await transactBlobJSON<AccessList>(ACCESS_STORE, ACCESS_KEY, { users: [] }, (current) => ({
    ...current,
    users: fn(Array.isArray(current?.users) ? [...current.users] : []),
  }));
  clearAccessCache();
}

export default async (req: Request) => {
  const denied = await requireAuth(req, { role: "admin" });
  if (denied) return denied;
  const me = currentUser(req)!;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("view") === "activity") {
        if (!atLeast(me, "senior")) throw new HttpError(403, "Only senior admins can see the activity log.");
        return json({ activity: await recentActivity() });
      }
      if (url.searchParams.get("ghl")) {
        const list = await loadAccess({ fresh: true });
        const ghlUsers = (await listLocationUsers({ fresh: !!url.searchParams.get("fresh") })).filter(
          (g) => !list.users.some((u) => u.id === g.id || (!!u.email && u.email === g.email)) && !isSenior(g),
        );
        return json({ ghlUsers });
      }
      return json(await snapshot(req));
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    let body: any;
    try {
      body = await req.json();
    } catch {
      throw new HttpError(400, "Invalid JSON body");
    }
    const action = String(body?.action || "");

    if (action === "add") {
      const role = body.role === "admin" ? "admin" : "user";
      if (role === "admin" && !atLeast(me, "senior")) throw new HttpError(403, "Only a senior admin can add an admin.");
      let entry: AccessEntry;
      const now = new Date().toISOString();
      if (body.userId) {
        const g = (await listLocationUsers()).find((u) => u.id === String(body.userId)) ||
          (await listLocationUsers({ fresh: true })).find((u) => u.id === String(body.userId));
        if (!g) throw new HttpError(404, "That GHL user wasn't found.");
        entry = { id: g.id, name: g.name, email: g.email, role, addedBy: me.name, addedAt: now };
      } else {
        // By email, for when the GHL users list isn't available. Tied to the
        // real GHL user the first time they open the Ledger inside GHL.
        const email = String(body.email || "").trim().toLowerCase();
        if (!EMAIL_RE.test(email)) throw new HttpError(400, "Pick a GHL user, or enter their GHL login email.");
        const name = String(body.name || "").trim().slice(0, 80) || email;
        entry = { id: `email:${email}`, name, email, role, addedBy: me.name, addedAt: now };
      }
      if (isSenior(entry)) throw new HttpError(409, `${entry.name} is already a senior admin.`);
      await mutateList((users) => {
        if (users.some((u) => u.id === entry.id || (!!u.email && u.email === entry.email))) {
          throw new HttpError(409, `${entry.name} is already on the list.`);
        }
        return [...users, entry];
      });
      await dropRequest(entry);
      await logActivity(req, role === "admin" ? "Added admin" : "Added user", `${entry.name}${entry.email ? ` (${entry.email})` : ""}`);
      return json({ ok: true, ...(await snapshot(req)) });
    }

    if (action === "remove" || action === "set-role") {
      const id = String(body.id || "");
      if (!id) throw new HttpError(400, "id is required");
      const target = (await loadAccess({ fresh: true })).users.find((u) => u.id === id);
      if (!target) throw new HttpError(404, "That person isn't on the list.");
      if (isSenior(target)) throw new HttpError(409, `${target.name} is a senior admin and can't be changed here (SENIOR_ADMINS in Netlify).`);

      if (action === "remove") {
        if (target.id === me.uid) throw new HttpError(409, "You can't remove yourself. Ask a senior admin.");
        if (target.role === "admin" && !atLeast(me, "senior")) throw new HttpError(403, "Only a senior admin can remove an admin.");
        await mutateList((users) => users.filter((u) => u.id !== id));
        await logActivity(req, target.role === "admin" ? "Removed admin" : "Removed user", target.name);
      } else {
        if (!atLeast(me, "senior")) throw new HttpError(403, "Only a senior admin can change roles.");
        const role = body.role === "admin" ? "admin" : "user";
        if (role !== target.role) {
          await mutateList((users) => users.map((u) => (u.id === id ? { ...u, role } : u)));
          await logActivity(req, role === "admin" ? "Made admin" : "Changed admin to user", target.name);
        }
      }
      return json({ ok: true, ...(await snapshot(req)) });
    }

    if (action === "dismiss-request") {
      const id = String(body.id || "");
      await dropRequest({ id });
      return json({ ok: true, ...(await snapshot(req)) });
    }

    throw new HttpError(400, "Unknown action");
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err?.message || "Access change failed" }, status);
  }
};

export const config = {
  path: "/.netlify/functions/access",
};
