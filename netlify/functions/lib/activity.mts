// Who did what - one shared, newest-first log in Netlify Blobs
// ("ghl-ledger-activity"), capped at MAX_ENTRIES. Senior admins see it on the
// Access tab. Best-effort: a failed log write never fails the action itself.

import { getStore } from "@netlify/blobs";
import { transactBlobJSON } from "./shared.mts";
import { currentUser } from "./auth-guard.mts";

export const ACTIVITY_STORE = "ghl-ledger-activity";
export const ACTIVITY_KEY = "log";
const MAX_ENTRIES = 3000;

export type ActivityEntry = {
  id: string;
  at: string;
  by: string; // display name
  byId: string; // GHL user id ("system" for cron / Make)
  via: string; // "ghl" | "pin" | "system"
  action: string; // e.g. "Approved bill"
  detail: string; // e.g. "Home Depot #1234 · $512.00"
  meta?: Record<string, unknown>;
};

type Actor = { uid: string; name: string; via: string };
// `actor` is the request (after requireAuth), an explicit actor, or null for System (cron, Make).
export async function logActivity(actor: Request | Actor | null, action: string, detail = "", meta?: Record<string, unknown>): Promise<void> {
  const who: Actor | null = actor instanceof Request ? currentUser(actor) : actor;
  const entry: ActivityEntry = {
    id: "act_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    at: new Date().toISOString(),
    by: who?.name || "System",
    byId: who?.uid || "system",
    via: who?.via || "system",
    action,
    detail: String(detail || "").slice(0, 300),
    ...(meta ? { meta } : {}),
  };
  try {
    await transactBlobJSON<ActivityEntry[]>(ACTIVITY_STORE, ACTIVITY_KEY, [], (current) =>
      [entry, ...(Array.isArray(current) ? current : [])].slice(0, MAX_ENTRIES),
    );
  } catch (err) {
    console.warn("Activity log write failed:", err);
  }
}

export async function recentActivity(limit = 500): Promise<ActivityEntry[]> {
  const data = (await getStore(ACTIVITY_STORE).get(ACTIVITY_KEY, { type: "json" })) as ActivityEntry[] | null;
  return (Array.isArray(data) ? data : []).slice(0, limit);
}

export const money = (n: unknown) => "$" + (Number(n) || 0).toFixed(2);
