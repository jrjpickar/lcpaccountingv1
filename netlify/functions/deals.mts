// GET/POST/DELETE /api/deals
//
// The Deals tab: closed (won) deals only. GHL is the source of truth for
// WHICH deals closed and WHEN - every opportunity with status "won" in the
// acquisitions and retail pipelines, dated by GHL's native close date. What
// GHL doesn't track (contract price, assignment fee, EMD, buyer, escrow, the
// fee actually received) lives in one Netlify Blobs record per opportunity
// id, so it survives a refresh and is shared by everyone.
//
// Which pipelines:
//   - DEALS_PIPELINE_IDS (optional env, comma separated ids). Without it,
//     every pipeline whose name contains "acq" or "retail" is used.
//
// GET returns:
//   { pipelines: [{ id, name, kind, count }], deals: [row], fellOut: [row],
//     truncated, fetchedAt }
// where `deals` are won opportunities (row.closedAt / row.closedDate =
// GHL close date) and `fellOut` are deal records whose opportunity is no
// longer won (reopened, lost) or no longer in those pipelines - kept so
// earnest money on a cancelled contract never drops off the radar.
//
// POST { opportunityId, ...fields } upserts a deal record (partial update).
// DELETE ?opportunityId= removes a record (the GHL opportunity is untouched).
//
// Required env vars: GHL_PIT_TOKEN, GHL_LOCATION_ID.

import { getStore } from "@netlify/blobs";
import { fetchAllOpportunities, fetchPipelines, type GhlPipeline } from "./lib/ghl.mts";
import {
  DEALS_STORE,
  DEALS_KEY,
  type DealRecord,
  type EmdStatus,
  HttpError,
  transactBlobJSON,
  json,
} from "./lib/shared.mts";
import { requireAuth, actorName } from "./lib/auth-guard.mts";
import { logActivity, money } from "./lib/activity.mts";

type DealMap = Record<string, DealRecord>;

const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

type DealPipeline = GhlPipeline & { kind: "acquisitions" | "retail" | "other" };

function pipelineKind(name: string): DealPipeline["kind"] {
  const n = norm(name);
  if (/\bacq/.test(n)) return "acquisitions";
  if (/retail/.test(n)) return "retail";
  return "other";
}

function pickPipelines(pipelines: GhlPipeline[]): DealPipeline[] {
  const ids = String(process.env.DEALS_PIPELINE_IDS || process.env.DEALS_PIPELINE_ID || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const chosen = ids.length
    ? pipelines.filter((p) => ids.includes(p.id))
    : pipelines.filter((p) => pipelineKind(p.name) !== "other");
  return chosen.map((p) => ({ ...p, kind: pipelineKind(p.name) }));
}

// GHL's native close date for a won opportunity. Field names differ between
// API versions, so check the known ones, then fall back to the moment the
// status last changed (which is when it was marked won).
const CLOSE_FIELDS = ["closedDate", "closeDate", "dateClosed", "closedAt", "wonAt", "lastStatusChangeAt"] as const;
export function closeDateOf(opp: any): { at: string | null; field: string | null } {
  for (const f of CLOSE_FIELDS) {
    const v = opp?.[f];
    if (v && !Number.isNaN(Date.parse(v))) return { at: new Date(v).toISOString(), field: f };
  }
  return { at: null, field: null };
}
function laDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function contactName(opp: any): string {
  const c = opp?.contact || {};
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "";
}

function toRow(opp: any, pipeline: DealPipeline | null, stageName: string, locationId: string, record: DealRecord | null) {
  const close = closeDateOf(opp);
  return {
    id: opp.id,
    name: opp.name || record?.propertyAddress || "Untitled deal",
    contactName: contactName(opp) || record?.sellerName || "",
    contactId: opp.contactId || opp.contact?.id || null,
    pipelineId: pipeline?.id || opp.pipelineId || null,
    pipelineName: pipeline?.name || "",
    pipelineKind: pipeline?.kind || "other",
    stageId: opp.pipelineStageId || null,
    stageName,
    status: opp.status || null,
    monetaryValue: Number(opp.monetaryValue) || 0,
    source: opp.source || null,
    closedAt: close.at,
    closedDate: laDate(close.at),
    closedField: close.field,
    lastStageChangeAt: opp.lastStageChangeAt || opp.updatedAt || opp.createdAt || null,
    createdAt: opp.createdAt || null,
    locationId,
    record,
  };
}

async function readDeals(): Promise<DealMap> {
  const data = await getStore(DEALS_STORE).get(DEALS_KEY, { type: "json" });
  return data && typeof data === "object" && !Array.isArray(data) ? (data as DealMap) : {};
}

const EMD_STATUSES: EmdStatus[] = ["none", "held", "refunded", "forfeited"];
const MONEY_FIELDS = ["contractPrice", "assignmentFee", "emdAmount", "buyerDeposit", "feeReceived", "closingCosts"] as const;
const TEXT_FIELDS = ["buyerName", "escrowCompany", "escrowNumber", "notes", "propertyAddress", "sellerName"] as const;
const DATE_FIELDS = ["emdDate", "contractDate", "expectedCloseDate", "feeReceivedDate"] as const;

function moneyOrNull(v: any, field: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number`);
  if (n < 0) throw new HttpError(400, `${field} can't be negative`);
  return Math.round(n * 100) / 100;
}
function dateOrEmpty(v: any, field: string): string {
  if (v === null || v === undefined || v === "") return "";
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${field} must be a YYYY-MM-DD date`);
  return s;
}

function blankRecord(id: string, now: string): DealRecord {
  return {
    opportunityId: id,
    contractPrice: null,
    assignmentFee: null,
    emdAmount: null,
    emdStatus: "none",
    buyerName: "",
    buyerContactId: null,
    buyerDeposit: null,
    escrowCompany: "",
    escrowNumber: "",
    feeReceived: null,
    closingCosts: null,
    notes: "",
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

// Human-readable summary of what changed, for the deal's history + the activity log.
function describeChanges(before: DealRecord, after: DealRecord): string[] {
  const out: string[] = [];
  const label: Record<string, string> = {
    contractPrice: "Contract price", assignmentFee: "Assignment fee", emdAmount: "EMD", buyerDeposit: "Buyer deposit",
    feeReceived: "Fee received", closingCosts: "Closing costs", buyerName: "Buyer", escrowCompany: "Escrow company",
    escrowNumber: "Escrow #", expectedCloseDate: "Expected close", contractDate: "Contract date",
    feeReceivedDate: "Fee received date", emdDate: "EMD date", emdStatus: "EMD status",
  };
  for (const k of Object.keys(label)) {
    const a = (before as any)[k], b = (after as any)[k];
    if ((a ?? "") === (b ?? "")) continue;
    const fmt = (v: any) => (v === null || v === undefined || v === "" ? "blank" : MONEY_FIELDS.includes(k as any) ? money(v) : String(v));
    out.push(`${label[k]}: ${fmt(a)} → ${fmt(b)}`);
  }
  if ((before.notes || "") !== (after.notes || "")) out.push("Notes updated");
  return out;
}

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const token = process.env.GHL_PIT_TOKEN;
    const locationId = process.env.GHL_LOCATION_ID;
    if (!token || !locationId) {
      return json({ error: "Missing GHL_PIT_TOKEN or GHL_LOCATION_ID environment variable" }, 500);
    }
    try {
      const [allPipelines, records] = await Promise.all([fetchPipelines(token, locationId), readDeals()]);
      const pipelines = pickPipelines(allPipelines);
      if (!pipelines.length) {
        return json({
          error: process.env.DEALS_PIPELINE_IDS || process.env.DEALS_PIPELINE_ID
            ? "None of the DEALS_PIPELINE_IDS were found in this location"
            : "Couldn't find an acquisitions or retail pipeline - set DEALS_PIPELINE_IDS in Netlify",
          pipelines: allPipelines.map((p) => ({ id: p.id, name: p.name })),
        }, 404);
      }

      const results = await Promise.all(pipelines.map((p) =>
        fetchAllOpportunities(token, locationId, { pipelineId: p.id, status: "won" })));
      const stageName: Record<string, string> = {};
      pipelines.forEach((p) => p.stages.forEach((st) => { stageName[st.id] = st.name; }));

      const deals: any[] = [];
      const seen = new Set<string>();
      let truncated = false;
      const counts: Record<string, number> = {};
      results.forEach((r, i) => {
        const p = pipelines[i];
        truncated = truncated || r.truncated;
        for (const opp of r.opportunities) {
          if (String(opp.status || "").toLowerCase() !== "won" || seen.has(opp.id)) continue;
          seen.add(opp.id);
          counts[p.id] = (counts[p.id] || 0) + 1;
          deals.push(toRow(opp, p, stageName[opp.pipelineStageId] || "", locationId, records[opp.id] || null));
        }
      });
      deals.sort((a, b) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")));

      // Saved deal records whose opportunity isn't a won deal any more.
      const fellOut: any[] = [];
      for (const id of Object.keys(records)) {
        if (seen.has(id)) continue;
        const r = records[id];
        fellOut.push({
          id, name: r.propertyAddress || "Deal no longer won in GHL", contactName: r.sellerName || "", contactId: null,
          pipelineId: null, pipelineName: "", pipelineKind: "other", stageId: null, stageName: "Not won",
          status: null, monetaryValue: 0, source: null, closedAt: null, closedDate: "", closedField: null,
          lastStageChangeAt: null, createdAt: r.createdAt, locationId, record: r,
        });
      }

      return json({
        pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, kind: p.kind, count: counts[p.id] || 0 })),
        deals,
        fellOut,
        truncated,
        fetchedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      return json({ error: String(err?.message || err) }, 502);
    }
  }

  if (req.method === "POST") {
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
    const id = String(body?.opportunityId || "").trim();
    if (!id) return json({ error: "opportunityId is required" }, 400);

    const now = new Date().toISOString();
    const by = actorName(req);
    let saved: DealRecord | null = null;
    let changes: string[] = [];
    try {
      await transactBlobJSON<DealMap>(DEALS_STORE, DEALS_KEY, {}, (current) => {
        const map = current && typeof current === "object" && !Array.isArray(current) ? current : {};
        const before: DealRecord = map[id] ? { ...map[id] } : blankRecord(id, now);
        const next: DealRecord = { ...before, history: [...(before.history || [])] };
        for (const f of MONEY_FIELDS) if (f in body) (next as any)[f] = moneyOrNull(body[f], f);
        for (const f of TEXT_FIELDS) if (f in body) (next as any)[f] = String(body[f] ?? "").slice(0, f === "notes" ? 4000 : 200);
        for (const f of DATE_FIELDS) if (f in body) (next as any)[f] = dateOrEmpty(body[f], f);
        if ("buyerContactId" in body) next.buyerContactId = body.buyerContactId ? String(body.buyerContactId) : null;
        if ("emdStatus" in body) {
          if (!EMD_STATUSES.includes(body.emdStatus)) throw new HttpError(400, "emdStatus must be none, held, refunded or forfeited");
          next.emdStatus = body.emdStatus;
        }
        if (next.feeReceived != null && next.feeReceived > 0 && !next.feeReceivedDate) {
          throw new HttpError(400, "Add the date the fee was received");
        }
        changes = describeChanges(before, next);
        if (!map[id]) changes.unshift("Deal record created");
        next.updatedAt = now;
        next.updatedBy = by;
        if (changes.length) next.history.push({ ts: now, action: "updated", note: changes.join("; "), by });
        next.history = next.history.slice(-100);
        saved = next;
        return { ...map, [id]: next };
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to save deal" }, status);
    }
    if (changes.length) {
      const label = (saved as any)?.propertyAddress || id;
      await logActivity(req, "Updated deal", `${label} · ${changes.join("; ")}`.slice(0, 300));
    }
    return json(saved);
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("opportunityId");
    if (!id) return json({ error: "opportunityId query param is required" }, 400);
    let label = id;
    try {
      await transactBlobJSON<DealMap>(DEALS_STORE, DEALS_KEY, {}, (current) => {
        const map = { ...(current || {}) };
        if (!map[id]) throw new HttpError(404, "No deal record for that opportunity");
        label = map[id].propertyAddress || id;
        delete map[id];
        return map;
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to delete deal record" }, status);
    }
    await logActivity(req, "Deleted deal record", label);
    return json({ ok: true, opportunityId: id });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = {
  path: "/.netlify/functions/deals",
};
