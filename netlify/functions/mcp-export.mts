// GET /api/mcp-export
//
// Read-only export for the LCP MCP reporting site (a separate Netlify site).
//   deals: the money fields of each deal record, joined there to GHL opportunities by id.
//   spend: paid bill amounts by payment date and category (cash basis). A payment on a
//          bill with several line items is split across them by line-item share.
//   ap:    what is still owed on pending + approved bills.
// No vendor names, buyer names, escrow numbers, notes or history leave the Ledger.
//
// Protected by MCP_EXPORT_KEY (at least 24 characters), sent as the x-mcp-key header.
// Without that env var the endpoint is off (401). Set the same value as
// LEDGER_EXPORT_KEY on the LCP MCP site.

import { getStore } from "@netlify/blobs";
import { DEALS_STORE, DEALS_KEY, BILLS_STORE, BILLS_KEY, type DealRecord, type Bill, json } from "./lib/shared.mts";
import { safeEqual } from "../shared/auth.ts";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function spendRows(bills: Bill[]) {
  const rows: { date: string; category: string; amount: number }[] = [];
  for (const bill of bills) {
    if (!bill || bill.status === "rejected") continue;
    const items = (bill.lineItems || []).filter((li) => Number(li.amount) > 0);
    const total = items.reduce((s, li) => s + Number(li.amount), 0);
    for (const p of bill.payments || []) {
      const amt = Number(p.amount) || 0;
      if (!amt || !p.date) continue;
      if (!total) { rows.push({ date: p.date.slice(0, 10), category: "Uncategorized", amount: round2(amt) }); continue; }
      for (const li of items) rows.push({ date: p.date.slice(0, 10), category: li.category || "Uncategorized", amount: round2(amt * Number(li.amount) / total) });
    }
  }
  return rows;
}

export default async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const expected = process.env.MCP_EXPORT_KEY || "";
  const sent = req.headers.get("x-mcp-key") || "";
  if (expected.length < 24 || !safeEqual(sent, expected)) return json({ error: "Unauthorized" }, 401);
  const [dealMap, billsRaw] = await Promise.all([
    getStore(DEALS_STORE).get(DEALS_KEY, { type: "json" }),
    getStore(BILLS_STORE).get(BILLS_KEY, { type: "json" }),
  ]);
  const map = (dealMap || {}) as Record<string, DealRecord>;
  const bills: Bill[] = Array.isArray(billsRaw) ? billsRaw : Object.values((billsRaw || {}) as Record<string, Bill>);
  const deals = Object.values(map).filter((d) => d && d.opportunityId).map((d) => ({
    opportunityId: d.opportunityId,
    propertyAddress: d.propertyAddress || null,
    contractPrice: d.contractPrice ?? null,
    assignmentFee: d.assignmentFee ?? null,
    feeReceived: d.feeReceived ?? null,
    feeReceivedDate: d.feeReceivedDate || null,
    contractDate: d.contractDate || null,
    expectedCloseDate: d.expectedCloseDate || null,
    emdAmount: d.emdAmount ?? null,
    emdStatus: d.emdStatus || "none",
    closingCosts: d.closingCosts ?? null,
  }));
  const open = bills.filter((b) => b && (b.status === "pending" || b.status === "approved") && Number(b.balance) > 0);
  return json({
    deals,
    spend: spendRows(bills),
    ap: { owed: round2(open.reduce((s, b) => s + Number(b.balance), 0)), count: open.length },
    exportedAt: new Date().toISOString(),
  });
};

export const config = { path: "/api/mcp-export" };
