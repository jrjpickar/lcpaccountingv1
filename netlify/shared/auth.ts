// Per-user sign-in for the Ledger - shared by the edge function that gates
// the page (netlify/edge-functions/auth-gate.ts) and by every serverless
// function's own check (netlify/functions/lib/auth-guard.mts), so both sides
// agree on exactly one token format. Uses only Web Crypto + @netlify/blobs,
// which both runtimes (Deno at the edge, Node in functions) support.
//
// Same model as the dispatch board, with one big difference: being a GHL
// user is NOT enough. You also have to be on the Ledger access list.
//
// How someone signs in:
//   - Inside GHL (normal): the Ledger is a Custom Page of its own private GHL
//     Marketplace app. The page asks GHL for the logged-in user
//     (REQUEST_USER_DATA); GHL answers encrypted with the app's Shared
//     Secret; /api/session decrypts it with GHL_APP_SHARED_SECRET, checks the
//     location and the access list, and issues a session ("ghl"). 7 days,
//     renewed on every load inside GHL.
//   - Outside GHL (bookmark, phone), optional: email + LEDGER_PIN ("pin").
//     Only works for emails on the access list. PIN sessions are always
//     plain-user level - admin tools need a GHL sign-in, because the PIN is
//     shared and would otherwise let anyone claim to be an admin.
//
// Token: "v2.<base64url JSON payload>.<hex HMAC-SHA256(secret, 'v2|'+payload)>"
// sent as an HttpOnly cookie AND an x-ledger-auth header (GHL's iframe can
// block cookies). `secret` is 32 random bytes kept in Netlify Blobs, never in
// the code. PIN sessions also carry a hash of the PIN, so changing LEDGER_PIN
// signs every PIN session out.
//
// Every request re-checks the access list (cached ~20 s per instance), so
// removing someone locks them out right away - not when their session ends.
//
// Roles:
//   senior - brycetooley@gmail.com (built in, can't be removed) + SENIOR_ADMINS.
//            Everything, plus promote/demote admins, activity log, YTD
//            baseline, partner split.
//   admin  - add/remove regular users.
//   user   - all day-to-day accounting (deals, bills, payments, partner entries,
//            recurring bills, reports).

import { getStore } from "@netlify/blobs";

export const AUTH_COOKIE = "ledger_session";
export const AUTH_HEADER = "x-ledger-auth";
export const AUTH_STORE = "ghl-ledger-auth";
export const ACCESS_STORE = "ghl-ledger-access";
export const ACCESS_KEY = "list";
export const GHL_SESSION_DAYS = 7;
export const PIN_SESSION_DAYS = 30;

// Failsafe: always a senior admin, even if SENIOR_ADMINS is deleted, blank or wrong.
export const OWNER_EMAIL = "brycetooley@gmail.com";

export type Role = "senior" | "admin" | "user";
export type Via = "ghl" | "pin";
export type SessionPayload = {
  v: 2;
  uid: string;
  name: string;
  email: string;
  via: Via;
  iat: number; // seconds
  exp: number; // seconds
  ph?: string; // PIN hash (pin sessions only)
};
export type AccessEntry = {
  id: string; // GHL user id, or "email:<address>" until that person first signs in through GHL
  name: string;
  email: string;
  role: "admin" | "user";
  addedBy: string;
  addedAt: string;
  lastSeenAt?: string;
};
export type AccessList = { users: AccessEntry[] };
// Who is making a request, after the session and the access list both check out.
export type Principal = {
  uid: string;
  name: string;
  email: string;
  via: Via;
  role: Role; // what they are
  effectiveRole: Role; // what this session can do (PIN sessions are capped at "user")
};

declare const Netlify: any;

export function env(name: string): string {
  let v: string | undefined;
  try {
    if (typeof Netlify !== "undefined" && Netlify?.env?.get) v = Netlify.env.get(name);
  } catch {}
  if (v == null && typeof process !== "undefined") v = (process as any).env?.[name];
  return String(v ?? "").trim();
}

// LEDGER_PASSWORD (12-256 characters) takes precedence over the legacy numeric PIN.
// A configured but invalid password fails closed; no fallback to LEDGER_PIN.
export function getPin(): string | null {
  const password = env("LEDGER_PASSWORD");
  if (password) return password.length >= 12 && password.length <= 256 ? password : null;
  const pin = env("LEDGER_PIN");
  return /^\d{4,12}$/.test(pin) ? pin : null;
}
export const ghlSignInConfigured = () => !!env("GHL_APP_SHARED_SECRET");

// ---------- secret ----------
let cachedSecret: string | null = null;
export async function getAuthSecret(): Promise<string> {
  const configured = env("LEDGER_AUTH_SECRET");
  if (configured) {
    if (configured.length < 32) throw new Error("LEDGER_AUTH_SECRET must be at least 32 characters");
    return configured;
  }
  if (cachedSecret) return cachedSecret;
  const store = getStore(AUTH_STORE);
  let secret = (await store.get("secret", { type: "text", consistency: "strong" })) as string | null;
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const fresh = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    // onlyIfNew: if two cold starts race here, both end up reading the one that won.
    await store.set("secret", fresh, { onlyIfNew: true });
    secret = (await store.get("secret", { type: "text", consistency: "strong" })) as string | null;
  }
  if (!secret) throw new Error("Could not initialize the auth secret");
  cachedSecret = secret;
  return secret;
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function pinHash(pin: string): Promise<string> {
  return (await hmacHex(await getAuthSecret(), `pin|${pin}`)).slice(0, 24);
}

// ---------- sessions ----------
export async function signSession(
  user: { id: string; name: string; email: string },
  via: Via,
): Promise<{ token: string; maxAge: number; expires: number }> {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = (via === "ghl" ? GHL_SESSION_DAYS : PIN_SESSION_DAYS) * 86400;
  const payload: SessionPayload = { v: 2, uid: user.id, name: user.name, email: user.email.toLowerCase(), via, iat: now, exp: now + maxAge };
  if (via === "pin") {
    const pin = getPin();
    if (!pin) throw new Error("LEDGER_PIN is not set");
    payload.ph = await pinHash(pin);
  }
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(await getAuthSecret(), `v2|${body}`);
  return { token: `v2.${body}.${sig}`, maxAge, expires: payload.exp * 1000 };
}

// Checks the signature, expiry and (for PIN sessions) that the PIN hasn't
// changed. Does NOT check the access list - authenticate() does that.
export async function verifyToken(token: string | null | undefined): Promise<SessionPayload | null> {
  const m = /^v2\.([A-Za-z0-9_-]{10,4000})\.([0-9a-f]{64})$/.exec(String(token || "").trim());
  if (!m) return null;
  const expected = await hmacHex(await getAuthSecret(), `v2|${m[1]}`);
  if (!safeEqual(expected, m[2])) return null;
  let p: SessionPayload;
  try {
    p = JSON.parse(b64urlDecode(m[1]));
  } catch {
    return null;
  }
  if (!p || p.v !== 2 || !p.uid || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
  if (p.via !== "ghl" && p.via !== "pin") return null;
  if (p.via === "pin") {
    const pin = getPin();
    if (!pin || !p.ph || !safeEqual(p.ph, await pinHash(pin))) return null;
  }
  return p;
}

// ---------- access list ----------
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function seniorKeys(): string[] {
  const list = env("SENIOR_ADMINS").split(",").map(norm).filter(Boolean);
  return [...new Set([OWNER_EMAIL, ...list])];
}
export function isSenior(user: { id?: string; uid?: string; name?: string; email?: string } | null | undefined): boolean {
  if (!user) return false;
  // Email or GHL user id only - never by name, since two GHL users can share one.
  const keys = seniorKeys();
  const email = norm(user.email), id = norm(user.id ?? user.uid);
  return keys.some((k) => (!!email && k === email) || (!!id && k === id));
}

let accessCache: { at: number; list: AccessList } | null = null;
const ACCESS_CACHE_MS = 20_000;
export function clearAccessCache() {
  accessCache = null;
}
export async function loadAccess({ fresh = false } = {}): Promise<AccessList> {
  if (!fresh && accessCache && Date.now() - accessCache.at < ACCESS_CACHE_MS) return accessCache.list;
  const raw = (await getStore(ACCESS_STORE).get(ACCESS_KEY, { type: "json" })) as AccessList | null;
  const list: AccessList = { users: Array.isArray(raw?.users) ? raw!.users : [] };
  accessCache = { at: Date.now(), list };
  return list;
}
export function findEntry(list: AccessList, who: { id?: string; uid?: string; email?: string }): AccessEntry | null {
  const id = String(who.id ?? who.uid ?? "");
  const email = norm(who.email);
  return list.users.find((u) => (id && u.id === id) || (email && norm(u.email) === email)) || null;
}
export function roleFor(list: AccessList, who: { id?: string; uid?: string; name?: string; email?: string }): Role | null {
  if (isSenior(who)) return "senior";
  const entry = findEntry(list, who);
  return entry ? entry.role : null;
}

export async function principalFromToken(token: string | null | undefined): Promise<Principal | null> {
  const p = await verifyToken(token);
  if (!p) return null;
  const role = roleFor(await loadAccess(), { id: p.uid, name: p.name, email: p.email });
  if (!role) return null; // removed from the access list
  return {
    uid: p.uid,
    name: p.name,
    email: p.email,
    via: p.via,
    role,
    effectiveRole: p.via === "ghl" ? role : "user",
  };
}

export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Header first (it's what the page sends), then the cookie.
export async function authenticate(req: Request): Promise<Principal | null> {
  return (await principalFromToken(req.headers.get(AUTH_HEADER))) || (await principalFromToken(readCookie(req, AUTH_COOKIE)));
}
export async function isAuthenticated(req: Request): Promise<boolean> {
  return !!(await authenticate(req));
}

const RANK: Record<Role, number> = { user: 1, admin: 2, senior: 3 };
export const atLeast = (p: Principal | null, role: Role) => !!p && RANK[p.effectiveRole] >= RANK[role];

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  // SameSite=None + Partitioned so it still works inside GHL's iframe where
  // browsers allow it; the header fallback covers the rest.
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=None; Partitioned`;
}
