// GET/POST /api/partners
//
// The partners' capital ledger: who's in the LLC, each member's ownership
// split, and every capital contribution / distribution. Replaces the A2Z
// version's BBSI payroll ledger - for a wholesale LLC the money that moves
// between the company and its members is what matters at tax time (K-1s,
// capital accounts), not payroll.
//
// GET returns { members: [{ id, name, pct }], entries: [...] }.
// POST actions:
//   { action: "add-entry", memberId, type: "contribution"|"distribution", amount, date, note }
//   { action: "delete-entry", id }
//   { action: "set-members", members: [{ id?, name, pct }] }   - senior admins only
//
// One Netlify Blobs record, same transactBlobJSON pattern as everything else.

import { getStore } from "@netlify/blobs";
import {
  PARTNERS_STORE,
  PARTNERS_KEY,
  DEFAULT_PARTNERS,
  type PartnersData,
  type PartnerEntry,
  type PartnerMember,
  HttpError,
  transactBlobJSON,
  json,
} from "./lib/shared.mts";
import { requireAuth, actorName, currentUser } from "./lib/auth-guard.mts";
import { atLeast } from "../shared/auth.ts";
import { logActivity, money } from "./lib/activity.mts";

function normalize(data: any): PartnersData {
  if (!data || typeof data !== "object" || !Array.isArray(data.members)) return structuredClone(DEFAULT_PARTNERS);
  return { members: data.members, entries: Array.isArray(data.entries) ? data.entries : [] };
}

const newId = (p: string) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const data = await getStore(PARTNERS_STORE).get(PARTNERS_KEY, { type: "json" });
    return json(normalize(data));
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = String(body?.action || "");
  let logLine = "";
  let logAction = "";

  try {
    if (action === "add-entry") {
      const type = body.type === "distribution" ? "distribution" : body.type === "contribution" ? "contribution" : null;
      if (!type) throw new HttpError(400, "type must be contribution or distribution");
      const amount = Math.round(Number(String(body.amount ?? "").replace(/[$,\s]/g, "")) * 100) / 100;
      if (!(amount > 0)) throw new HttpError(400, "amount must be more than 0");
      const date = String(body.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
      let created: PartnerEntry | null = null;
      const result = await transactBlobJSON<PartnersData>(PARTNERS_STORE, PARTNERS_KEY, structuredClone(DEFAULT_PARTNERS), (cur) => {
        const d = normalize(cur);
        const member = d.members.find((m) => m.id === body.memberId);
        if (!member) throw new HttpError(400, "Pick a partner");
        created = {
          id: newId("pe"), memberId: member.id, type, amount, date,
          note: String(body.note || "").slice(0, 300), createdAt: new Date().toISOString(), createdBy: actorName(req),
        };
        logLine = `${member.name} · ${type} · ${money(amount)} on ${date}`;
        return { members: d.members, entries: [...d.entries, created] };
      });
      logAction = type === "contribution" ? "Recorded capital contribution" : "Recorded distribution";
      await logActivity(req, logAction, logLine);
      return json(normalize(result), 201);
    }

    if (action === "delete-entry") {
      const id = String(body.id || "");
      const result = await transactBlobJSON<PartnersData>(PARTNERS_STORE, PARTNERS_KEY, structuredClone(DEFAULT_PARTNERS), (cur) => {
        const d = normalize(cur);
        const e = d.entries.find((x) => x.id === id);
        if (!e) throw new HttpError(404, "Entry not found");
        const m = d.members.find((x) => x.id === e.memberId);
        logLine = `${m ? m.name : e.memberId} · ${e.type} · ${money(e.amount)} on ${e.date}`;
        return { members: d.members, entries: d.entries.filter((x) => x.id !== id) };
      });
      await logActivity(req, "Deleted partner entry", logLine);
      return json(normalize(result));
    }

    if (action === "set-members") {
      if (!atLeast(currentUser(req), "senior")) throw new HttpError(403, "Only senior admins can change the partners or their split.");
      const incoming: any[] = Array.isArray(body.members) ? body.members : [];
      const members: PartnerMember[] = incoming
        .map((m) => ({
          id: m.id ? String(m.id) : newId("m"),
          name: String(m.name || "").trim().slice(0, 80),
          pct: m.pct === null || m.pct === undefined || m.pct === "" ? null : Math.round(Number(m.pct) * 100) / 100,
        }))
        .filter((m) => m.name);
      if (!members.length) throw new HttpError(400, "Add at least one partner");
      if (members.some((m) => m.pct !== null && (!Number.isFinite(m.pct) || m.pct < 0 || m.pct > 100))) {
        throw new HttpError(400, "Ownership % must be between 0 and 100");
      }
      const total = members.reduce((s, m) => s + (m.pct || 0), 0);
      if (total > 100.005) throw new HttpError(400, `Ownership adds up to ${total}% - it can't be more than 100%`);
      const result = await transactBlobJSON<PartnersData>(PARTNERS_STORE, PARTNERS_KEY, structuredClone(DEFAULT_PARTNERS), (cur) => {
        const d = normalize(cur);
        const keep = new Set(members.map((m) => m.id));
        const orphan = d.entries.find((e) => !keep.has(e.memberId));
        if (orphan) throw new HttpError(409, "A partner with recorded entries can't be removed - delete their entries first.");
        return { members, entries: d.entries };
      });
      await logActivity(req, "Updated partners", members.map((m) => `${m.name} ${m.pct == null ? "?" : m.pct + "%"}`).join(", "));
      return json(normalize(result));
    }
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err.message || "Failed to save" }, status);
  }

  return json({ error: "Unknown action" }, 400);
};

export const config = {
  path: "/.netlify/functions/partners",
};
