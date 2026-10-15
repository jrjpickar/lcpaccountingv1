// GET/PUT /api/ytd-baseline
//
// The opening figures (from bank statements / the books / a CPA review),
// stored once as a fixed starting point ("baseline") so the Reports tab's YTD
// summary can show real full-year numbers instead of only what this app has
// seen since it went live. Nothing is stored until someone enters one.
// Everything AFTER the baseline's `asOf` date is rolled forward automatically,
// client-side, from live data this app already has (see ytdRollforward() in
// public/index.html):
//   - Revenue   += assignment fees received after asOf (Deals tab)
//   - Expenses  += bills dated/paid after asOf, forfeited EMD, closing costs
// so nothing here needs updating again until the next audit/close - at which
// point you replace the baseline with the new audited figures and a new asOf,
// and the rollforward restarts from there (no double counting, since only
// activity strictly after asOf is added on top).
//
// A PUT replaces the whole record (the Setup → "YTD baseline (audit review)"
// form always sends the complete thing). Same transactBlobJSON pattern as the
// other stores.

import { getStore } from "@netlify/blobs";
import { YTD_BASELINE_STORE, YTD_BASELINE_KEY, HttpError, transactBlobJSON, json } from "./lib/shared.mts";
import { requireAuth } from "./lib/auth-guard.mts";
import { logActivity, money } from "./lib/activity.mts";

export type YtdMonth = { month: string; revenue: number; expenses: number; collected: number };
// section: which part of the P&L a detail line belongs to - "cos" (cost of
// services), "opex", "below" (below the line: debt service, owner draws,
// taxes...) or "info" (shown as-is, not part of the P&L math).
export type YtdLine = { label: string; amount: number; section: "cos" | "opex" | "below" | "info" };
export type YtdBaseline = {
  year: number;
  periodStart: string; // YYYY-MM-DD - first day the figures cover (Jan 1 for a true YTD; can be earlier, e.g. a trailing 13 months)
  asOf: string; // YYYY-MM-DD - last day the figures cover, inclusive; everything after rolls forward live
  basis: "cash" | "accrual"; // cash: revenue = deposits, expenses = payments; accrual: invoiced / billed
  source: string;
  revenue: number;
  costOfRevenue: number;
  operatingExpenses: number;
  belowTheLine: number; // sum of the "below" lines - debt service, taxes, owner draws, etc.
  collected: number;
  monthly: YtdMonth[]; // optional month-by-month split of the baseline
  lines: YtdLine[]; // optional extra summary lines from the audit (reported as-is, not rolled forward)
  notes: string;
  updatedAt: string;
};

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

export default async (req: Request) => {
  // Everyone reads it (Reports); only senior admins change the audit figures.
  const denied = await requireAuth(req, { writeRole: "senior" });
  if (denied) return denied;

  if (req.method === "GET") {
    const store = getStore(YTD_BASELINE_STORE);
    const data = await store.get(YTD_BASELINE_KEY, { type: "json" });
    return json(data && typeof data === "object" ? data : null);
  }

  if (req.method === "PUT") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const asOf = String(body.asOf || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return json({ error: "asOf (YYYY-MM-DD) is required" }, 400);
    const year = Number(asOf.slice(0, 4));
    const periodStart = /^\d{4}-\d{2}-\d{2}$/.test(String(body.periodStart || "")) ? String(body.periodStart) : `${year}-01-01`;
    if (periodStart > asOf) return json({ error: "periodStart must be on or before asOf" }, 400);
    const basis = body.basis === "accrual" ? "accrual" : "cash";

    const monthly: YtdMonth[] = (Array.isArray(body.monthly) ? body.monthly : [])
      .filter((m: any) => m && /^\d{4}-\d{2}$/.test(String(m.month || "")))
      .map((m: any) => ({ month: String(m.month), revenue: num(m.revenue), expenses: num(m.expenses), collected: num(m.collected) }))
      .sort((a: YtdMonth, b: YtdMonth) => (a.month < b.month ? -1 : 1));

    const lines: YtdLine[] = (Array.isArray(body.lines) ? body.lines : [])
      .filter((l: any) => l && String(l.label || "").trim())
      .map((l: any) => ({
        label: String(l.label).trim().slice(0, 200),
        amount: num(l.amount),
        section: (["cos", "opex", "below", "info"].includes(l.section) ? l.section : "info") as YtdLine["section"],
      }));
    const belowTheLine = num(lines.filter((l) => l.section === "below").reduce((s, l) => s + l.amount, 0));

    const record: YtdBaseline = {
      year,
      periodStart,
      asOf,
      basis,
      source: String(body.source || "Audit review").slice(0, 200),
      revenue: num(body.revenue),
      costOfRevenue: num(body.costOfRevenue),
      operatingExpenses: num(body.operatingExpenses),
      belowTheLine,
      // On a cash basis, revenue IS cash collected.
      collected: basis === "cash" ? num(body.revenue) : num(body.collected),
      monthly,
      lines,
      notes: String(body.notes || "").slice(0, 4000),
      updatedAt: new Date().toISOString(),
    };

    try {
      await transactBlobJSON<YtdBaseline | null>(YTD_BASELINE_STORE, YTD_BASELINE_KEY, null, () => record);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to save YTD baseline" }, status);
    }
    await logActivity(req, "Changed YTD baseline", `as of ${asOf} · revenue ${money(record.revenue)}`);
    return json(record);
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = {
  path: "/.netlify/functions/ytd-baseline",
};
