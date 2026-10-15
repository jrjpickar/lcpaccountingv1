// Ledger sign-in (see netlify/shared/auth.ts for the whole model).
//   GET  /api/session                                   -> { signedIn, user, role, effectiveRole, via, ... }
//   POST /api/session { action: "ghl", encryptedData }  (GHL Custom Page REQUEST_USER_DATA)
//   POST /api/session { action: "pin", email, pin }     (outside GHL, if LEDGER_PIN is set)
//   POST /api/session { action: "signout" }
//
// A GHL user who isn't on the access list gets a 403 and is added to the
// "asked for access" list on the Access tab, so an admin can add them in one click.
//
// PIN guessing is throttled (Netlify Blobs, store "ghl-ledger-auth"):
//   - per client IP: 5 wrong tries within 15 minutes -> that IP is locked out
//     for the rest of those 15 minutes
//   - site-wide: 50 wrong tries within an hour -> PIN sign-in refused for the
//     rest of that hour. Existing sessions and GHL sign-in keep working.

import { getStore } from "@netlify/blobs";
import {
  ACCESS_KEY,
  ACCESS_STORE,
  AUTH_COOKIE,
  AUTH_STORE,
  type AccessEntry,
  type AccessList,
  authenticate,
  clearAccessCache,
  findEntry,
  getPin,
  ghlSignInConfigured,
  isSenior,
  loadAccess,
  roleFor,
  safeEqual,
  sessionCookie,
  signSession,
} from "../shared/auth.ts";
import { ghlUserFromContext, type GhlUser } from "./lib/ghl-sso.mts";
import { HttpError, transactBlobJSON, json } from "./lib/shared.mts";
import { logActivity } from "./lib/activity.mts";

export const REQUESTS_KEY = "requests";
export type AccessRequest = { id: string; name: string; email: string; at: string; count: number };

const IP_LIMIT = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_LIMIT = 50;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const SEEN_WRITE_MS = 12 * 60 * 60 * 1000;

type Counter = { fails: number; since: number };
async function readCounter(store: any, key: string, windowMs: number): Promise<Counter> {
  const c = (await store.get(key, { type: "json" })) as Counter | null;
  if (!c || Date.now() - c.since > windowMs) return { fails: 0, since: Date.now() };
  return c;
}

function withCookie(data: any, cookie: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": cookie },
  });
}
const clearCookie = () => `${AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`;

function info(p: { uid: string; name: string; email: string; via: string; role: string; effectiveRole: string } | null) {
  const base = { pinAvailable: !!getPin(), ghlAvailable: ghlSignInConfigured() };
  if (!p) return { signedIn: false, user: null, ...base };
  return {
    signedIn: true,
    user: { id: p.uid, name: p.name, email: p.email },
    via: p.via,
    role: p.role,
    effectiveRole: p.effectiveRole,
    // Admin rights exist but this session can't use them (PIN sign-in).
    adminLocked: p.role !== "user" && p.effectiveRole === "user",
    ...base,
  };
}

// Keeps the access entry in step with GHL: ties an email-only entry to the
// real GHL user id, refreshes name/email, stamps lastSeenAt. Senior admins get
// an entry on first sign-in so they show on the Access tab.
// Returns true when this counts as a fresh sign-in worth logging.
async function touchEntry(user: GhlUser): Promise<boolean> {
  let fresh = false;
  const now = new Date();
  const existing = findEntry(await loadAccess({ fresh: true }), user);
  if (existing && existing.id === user.id && existing.name === user.name && existing.email === user.email &&
      existing.lastSeenAt && now.getTime() - Date.parse(existing.lastSeenAt) < SEEN_WRITE_MS) return false;
  await transactBlobJSON<AccessList>(ACCESS_STORE, ACCESS_KEY, { users: [] }, (current) => {
    const users = Array.isArray(current?.users) ? [...current.users] : [];
    const i = users.findIndex((u) => u.id === user.id || (!!u.email && u.email.toLowerCase() === user.email));
    fresh = i < 0 || !users[i].lastSeenAt || now.getTime() - Date.parse(users[i].lastSeenAt!) >= SEEN_WRITE_MS;
    if (i >= 0) {
      users[i] = { ...users[i], id: user.id, name: user.name, email: user.email, lastSeenAt: now.toISOString() };
    } else if (isSenior(user)) {
      users.push({ id: user.id, name: user.name, email: user.email, role: "admin", addedBy: "built-in", addedAt: now.toISOString(), lastSeenAt: now.toISOString() });
    } else {
      return current; // not listed - nothing to touch
    }
    return { ...current, users };
  });
  clearAccessCache();
  return fresh;
}

async function recordRequest(user: GhlUser) {
  try {
    await transactBlobJSON<AccessRequest[]>(ACCESS_STORE, REQUESTS_KEY, [], (current) => {
      const list = Array.isArray(current) ? current.filter((r) => r.id !== user.id) : [];
      const prev = (current || []).find((r) => r.id === user.id);
      return [{ id: user.id, name: user.name, email: user.email, at: new Date().toISOString(), count: (prev?.count || 0) + 1 }, ...list].slice(0, 50);
    });
  } catch (err) {
    console.warn("Could not record access request:", err);
  }
}

export default async (req: Request, context: any) => {
  try {
    if (req.method === "GET") return json(info(await authenticate(req)));
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    if (body?.action === "signout" || body?.logout) {
      return withCookie({ ok: true, signedIn: false }, clearCookie());
    }

    if (body?.action === "ghl") {
      const user = ghlUserFromContext(body.encryptedData);
      const role = roleFor(await loadAccess({ fresh: true }), user);
      if (!role) {
        await recordRequest(user);
        return json({
          error: `${user.name} isn't on the Ledger access list yet. Ask a Ledger admin to add you - your request is already on their list.`,
          notListed: true,
          user: { name: user.name, email: user.email },
        }, 403);
      }
      const fresh = await touchEntry(user);
      const signed = { id: user.id, name: user.name, email: user.email };
      const { token, maxAge } = await signSession(signed, "ghl");
      const p = { uid: user.id, name: user.name, email: user.email, via: "ghl", role, effectiveRole: role };
      if (fresh) await logActivity({ uid: user.id, name: user.name, via: "ghl" }, "Signed in", `inside GHL · ${role}`);
      return withCookie({ ok: true, token, ...info(p) }, sessionCookie(token, maxAge));
    }

    if (body?.action === "pin") {
      const pin = getPin();
      if (!pin) throw new HttpError(403, "Sign-in outside GHL is turned off. Open the Ledger from inside GHL.");
      const store = getStore(AUTH_STORE);
      const ip = String(context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown").replace(/[^0-9a-fA-F:.]/g, "_");
      const ipKey = `fails/${ip}`;
      const [ipCounter, globalCounter] = await Promise.all([
        readCounter(store, ipKey, IP_WINDOW_MS),
        readCounter(store, "fails/_global", GLOBAL_WINDOW_MS),
      ]);
      if (ipCounter.fails >= IP_LIMIT) {
        const mins = Math.ceil((ipCounter.since + IP_WINDOW_MS - Date.now()) / 60000);
        throw new HttpError(429, `Too many wrong tries - try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
      }
      if (globalCounter.fails >= GLOBAL_LIMIT) {
        const mins = Math.ceil((globalCounter.since + GLOBAL_WINDOW_MS - Date.now()) / 60000);
        throw new HttpError(429, `PIN sign-in is locked after too many wrong tries - try again in ${mins} minute${mins === 1 ? "" : "s"}, or open the Ledger inside GHL.`);
      }

      const email = String(body.email || "").trim().toLowerCase();
      const given = String(body.pin ?? "").trim();
      const list = await loadAccess({ fresh: true });
      const entry: AccessEntry | null = email ? findEntry(list, { email }) : null;
      const senior = !!email && isSenior({ email });
      const ok = /^\d{4,12}$/.test(given) && safeEqual(given, pin) && (!!entry || senior);
      if (!ok) {
        await Promise.all([
          store.setJSON(ipKey, { fails: ipCounter.fails + 1, since: ipCounter.since }),
          store.setJSON("fails/_global", { fails: globalCounter.fails + 1, since: globalCounter.since }),
        ]);
        const left = IP_LIMIT - (ipCounter.fails + 1);
        throw new HttpError(401, `That email isn't on the access list, or the PIN is wrong - ${left > 0 ? `${left} tr${left === 1 ? "y" : "ies"} left` : "locked for 15 minutes"}.`);
      }
      if (ipCounter.fails) await store.delete(ipKey);

      const user = { id: entry?.id || `email:${email}`, name: entry?.name || email, email };
      const role = roleFor(list, user)!;
      const { token, maxAge } = await signSession(user, "pin");
      await logActivity({ uid: user.id, name: user.name, via: "pin" }, "Signed in", "outside GHL with the PIN");
      const p = { uid: user.id, name: user.name, email, via: "pin", role, effectiveRole: "user" };
      return withCookie({ ok: true, token, ...info(p) }, sessionCookie(token, maxAge));
    }

    if (body?.pin) throw new HttpError(400, "This sign-in page is out of date - reload it.");
    throw new HttpError(400, "Unknown session action");
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err?.message || "Sign-in failed" }, status);
  }
};

export const config = {
  path: "/.netlify/functions/session",
};
