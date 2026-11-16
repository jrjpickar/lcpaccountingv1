import test from "node:test";
import assert from "node:assert/strict";
import { getStore } from "@netlify/blobs";
import handler, { spendRows } from "../netlify/functions/mcp-export.mts";
import { DEALS_STORE, DEALS_KEY, BILLS_STORE, BILLS_KEY } from "../netlify/functions/lib/shared.mts";

const KEY = "k".repeat(32);
const req = (key?: string) => new Request("http://x/api/mcp-export", { headers: key ? { "x-mcp-key": key } : {} });

test("mcp-export is off without MCP_EXPORT_KEY and rejects a wrong key", async () => {
  delete process.env.MCP_EXPORT_KEY;
  assert.equal((await handler(req(KEY))).status, 401);
  process.env.MCP_EXPORT_KEY = KEY;
  assert.equal((await handler(req("wrong".repeat(7)))).status, 401);
  assert.equal((await handler(req())).status, 401);
});

test("spend splits each payment across line items by share", () => {
  const rows = spendRows([
    { status: "paid", lineItems: [{ description: "a", category: "Direct Mail", amount: 300 }, { description: "b", category: "Skip Tracing", amount: 100 }], payments: [{ id: "p", amount: 200, date: "2026-11-03", method: "ach" }] } as any,
    { status: "rejected", lineItems: [{ description: "x", category: "Taxes", amount: 50 }], payments: [{ id: "q", amount: 50, date: "2026-11-03", method: "ach" }] } as any,
  ]);
  assert.deepEqual(rows, [{ date: "2026-11-03", category: "Direct Mail", amount: 150 }, { date: "2026-11-03", category: "Skip Tracing", amount: 50 }]);
});

test("mcp-export returns money fields, spend and AP only", async () => {
  process.env.MCP_EXPORT_KEY = KEY;
  await getStore(DEALS_STORE).setJSON(DEALS_KEY, {
    o1: { opportunityId: "o1", propertyAddress: "1 Main St", contractPrice: 300000, assignmentFee: 15000, feeReceived: 15000, feeReceivedDate: "2026-11-02", buyerName: "Secret Buyer", notes: "private", emdAmount: 5000, emdStatus: "refunded", closingCosts: 800, history: [] },
  });
  await getStore(BILLS_STORE).setJSON(BILLS_KEY, [
    { id: "b1", vendorName: "Secret Vendor", status: "paid", amount: 100, balance: 0, lineItems: [{ description: "x", category: "SMS & Dialer", amount: 100 }], payments: [{ id: "p1", amount: 100, date: "2026-11-01", method: "card" }] },
    { id: "b2", vendorName: "Secret Vendor", status: "approved", amount: 250, balance: 250, lineItems: [{ description: "y", category: "Direct Mail", amount: 250 }], payments: [] },
  ]);
  const res = await handler(req(KEY));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deals[0].closingCosts, 800);
  assert.equal(body.deals[0].emdStatus, "refunded");
  assert.deepEqual(body.spend, [{ date: "2026-11-01", category: "SMS & Dialer", amount: 100 }]);
  assert.deepEqual(body.ap, { owed: 250, count: 1 });
  const text = JSON.stringify(body);
  assert.ok(!text.includes("Secret Buyer") && !text.includes("Secret Vendor") && !text.includes("private"));
});
