// Per-function sign-in check (see netlify/shared/auth.ts for the scheme).
// Every function calls this first, because the edge gate only protects the
// page - functions are also reachable directly at /.netlify/functions/<name>,
// which the edge gate can't cover. Returns a 401/403/503 Response to send
// back, or null when the request may proceed. After it passes, currentUser(req)
// returns who is making the request (for "who did what" stamps).

import { authenticate, atLeast, env, getPin, ghlSignInConfigured, safeEqual, type Principal, type Role } from "../../shared/auth.ts";
import { isScheduledInvocation } from "./shared.mts";

type GuardOptions = {
  // Methods called by something that can't sign in - the Make scenarios
  // posting a rendered PDF / a delivery confirmation back. When
  // MAKE_CALLBACK_SECRET is set in Netlify, those calls must carry it
  // (x-make-secret header, or ?secret= on the URL).
  openMethods?: string[];
  // Netlify's own cron tick (scheduled functions) - it carries no session.
  allowScheduled?: boolean;
  // Minimum role. Default "user" (anyone on the access list).
  role?: Role;
  // Minimum role for anything that isn't GET/HEAD (e.g. read for everyone,
  // write for senior admins only).
  writeRole?: Role;
};

const principals = new WeakMap<Request, Principal>();
export const currentUser = (req: Request): Principal | null => principals.get(req) || null;
// Short label for history entries and the activity log.
export const actorName = (req: Request): string => currentUser(req)?.name || "system";

function reply(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function makeCallbackAllowed(req: Request): boolean {
  const expected = env("MAKE_CALLBACK_SECRET");
  if (!expected) return true; // not turned on yet - see README "Make callbacks"
  const given = req.headers.get("x-make-secret") || new URL(req.url).searchParams.get("secret") || "";
  return safeEqual(given, expected);
}

const ROLE_WORDS: Record<Role, string> = { user: "Ledger users", admin: "admins", senior: "senior admins" };

export async function requireAuth(req: Request, opts: GuardOptions = {}): Promise<Response | null> {
  if (opts.openMethods && opts.openMethods.includes(req.method)) {
    return makeCallbackAllowed(req) ? null : reply({ error: "Missing or wrong Make callback secret" }, 401);
  }
  if (opts.allowScheduled && (await isScheduledInvocation(req))) return null;
  if (!ghlSignInConfigured() && !getPin()) {
    return reply({ error: "Sign-in isn't set up - set GHL_APP_SHARED_SECRET (and optionally LEDGER_PIN) in Netlify and redeploy." }, 503);
  }
  const who = await authenticate(req);
  if (!who) return reply({ error: "Not signed in", auth: "required" }, 401);
  principals.set(req, who);

  const isRead = req.method === "GET" || req.method === "HEAD";
  const needed: Role = (!isRead && opts.writeRole) || opts.role || "user";
  if (!atLeast(who, needed)) {
    const pinCapped = who.via === "pin" && who.role !== "user";
    return reply(
      {
        error: pinCapped
          ? `That needs ${ROLE_WORDS[needed]}, and admin tools only work when the Ledger is opened inside GHL.`
          : `Only ${ROLE_WORDS[needed]} can do that.`,
        auth: "forbidden",
      },
      403,
    );
  }
  return null;
}
