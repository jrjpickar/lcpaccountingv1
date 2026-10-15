// GET/POST/DELETE /api/deals
//
// The Deals tab. GHL is the source of truth for WHERE a deal is - its stage
// in the acquisitions pipeline - and this function pulls that live on every
// GET. What GHL doesn't track for us (contract price, assignment fee, EMD,
// buyer, escrow, the fee actually received) lives in one Netlify Blobs
// record per opportunity id, so it survives a refresh and is shared by
// everyone.
//
// Which pipeline / stages:
//   - DEALS_PIPELINE_ID (optional env) picks the pipeline by id. Without it,
//     the pipeline whose stage names best match DEAL_STAGES is used, so it
//     works without anyone looking up ids.
//   - DEAL_STAGES (optional env, comma separated, matched by name, case
//     insensitive) - the stages that count as a live deal. Default:
//     "Verbal Acceptance, Offer Sent, Inspection Period, Pending, Closed".
//   - The stage named "Closed" (or CLOSED_STAGE) is the closed column.
//
// GET returns:
//   { pipeline, stages: [{ id, name, isDeal, isClosed, count }], deals: [row],
//     fellOut: [row], truncated, fetchedAt }
// where `deals` are opportunities sitting in a deal stage right now and
// `fellOut` are opportunities that HAVE a deal record but have since moved
// to a non-deal stage (offer declined, ghosted...) or left the pipeline -
// kept so earnest money on a cancelled contract never drops off the radar.
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

const DEFAULT_DEAL_STAGES = ["Verbal Acceptance", "Offer Sent", "Inspection Period", "Pending", "Closed"];
const norm = (s: string) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

function dealStageNames(): string[] {
  const raw = process.env.DEAL_STAGES;
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_DEAL_STAGES;
  return list.length ? list : DEFAULT_DEAL_STAGES;
}
function closedStageName(): string {
  return process.env.CLOSED_STAGE || "Closed";
}

function pickPipeline(pipelines: GhlPipeline[], wanted: string[]): GhlPipeline | null {
  const byId = process.env.DEALS_PIPELINE_ID;
  if (byId) return pipelines.find((p) => p.id === byId) || null;
  const want = new Set(wanted.map(norm));
  let best: GhlPipeline | null = null;
  let bestScore = 0;
  for (const p of pipelines) {
    const score = p.stages.filter((st) => want.has(norm(st.name))).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function contactName(opp: any): string {
  const c = opp?.contact || {};
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || "";
}

function toRow(opp: any, stageName: string, locationId: string, record: DealRecord | null) {
  return {
    id: opp.id,
    name: opp.name || record?.propertyAddress || "Untitled deal",
    contactName: contactName(opp) || record?.sellerName || "",
    contactId: opp.contactId || opp.contact?.id || null,
    stageId: opp.pipelineStageId || null,
    stageName,
    status: opp.status || null,
    monetaryValue: Number(opp.monetaryValue) || 0,
    source: opp.source || null,
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
      const wanted = dealStageNames();
      const [pipelines, records] = await Promise.all([fetchPipelines(token, locationId), readDeals()]);
      const pipeline = pickPipeline(pipelines, wanted);
      if (!pipeline) {
        return json({
          error: process.env.DEALS_PIPELINE_ID
            ? `No pipeline with id ${process.env.DEALS_PIPELINE_ID} in this location`
            : `Couldn't find a pipeline with stages named ${wanted.join(", ")} - set DEALS_PIPELINE_ID / DEAL_STAGES in Netlify`,
          pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages.map((s) => s.name) })),
        }, 404);
      }
      const want = new Set(wanted.map(norm));
      const closedName = norm(closedStageName());
      const stageById: Record<string, { name: string; isDeal: boolean }> = {};
      pipeline.stages.forEach((st) => { stageById[st.id] = { name: st.name, isDeal: want.has(norm(st.name)) }; });

      const { opportunities, truncated } = await fetchAllOpportunities(token, locationId, { pipelineId: pipeline.id, status: "all" });

      const counts: Record<string, number> = {};
      const deals: any[] = [];
      const seen = new Set<string>();
      for (const opp of opportunities) {
        const st = stageById[opp.pipelineStageId];
        counts[opp.pipelineStageId] = (counts[opp.pipelineStageId] || 0) + 1;
        seen.add(opp.id);
        if (st && st.isDeal) deals.push(toRow(opp, st.name, locationId, records[opp.id] || null));
      }
      // Deals with a record that are no longer in a deal stage.
      const fellOut: any[] = [];
      for (const opp of opportunities) {
        const st = stageById[opp.pipelineStageId];
        if (records[opp.id] && !(st && st.isDeal)) fellOut.push(toRow(opp, st ? st.name : "Unknown stage", locationId, records[opp.id]));
      }
      for (const id of Object.keys(records)) {
        if (seen.has(id)) continue;
        const r = records[id];
        fellOut.push({
          id, name: r.propertyAddress || "Deal no longer in GHL", contactName: r.sellerName || "", contactId: null,
          stageId: null, stageName: "Not in pipeline", status: null, monetaryValue: 0, source: null,
          lastStageChangeAt: null, createdAt: r.createdAt, locationId, record: r,
        });
      }

      return json({
        pipeline: { id: pipeline.id, name: pipeline.name },
        stages: pipeline.stages.map((st) => ({
          id: st.id, name: st.name, isDeal: want.has(norm(st.name)), isClosed: norm(st.name) === closedName, count: counts[st.id] || 0,
        })),
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
