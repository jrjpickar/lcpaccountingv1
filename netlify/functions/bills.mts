// GET/POST/PUT /api/bills
//
// True accounts-payable backend: vendor bills with line items, an approval
// workflow (pending -> approved -> paid, with reject/reopen),
// and partial-payment tracking. Persisted in Netlify Blobs (a JSON array
// under one key) - no external database, but data now survives a refresh
// and is shared across everyone hitting this site.
//
// Bills can also arrive here already-made: run-recurring-bills.mts (a
// scheduled function) writes directly into the same Blobs store on its own
// cadence, tagging what it creates with recurringTemplateId/isEstimated/
// varyFloor/varyCeiling. Those fields pass through here untouched.
//
// Concurrency: every write goes through transactBlobJSON() (see lib/shared.mts),
// which uses Netlify Blobs' conditional writes (onlyIfMatch/onlyIfNew) to
// detect if someone else - another clerk, or the recurring-bills cron -
// wrote to this same store in the gap between our read and our write. If
// so, it re-reads and re-applies the mutation against fresh data instead of
// silently clobbering the other write. Validation (bad input, wrong
// workflow state, not found) is thrown as an HttpError from inside the
// mutation, which aborts with nothing written and is mapped back to the
// right status code below - it is never treated as a write conflict.
//
// A create request can include a client-generated `clientRequestId`; a
// second POST with the same id (a double-click, or a client retry after a
// dropped response) returns the bill that already exists instead of
// creating a duplicate.

import { getStore } from "@netlify/blobs";
import {
  type Bill,
  BILLS_STORE,
  BILLS_KEY,
  HttpError,
  addDays,
  daysFromTerms,
  recompute,
  assertBillInvariant,
  transactBlobJSON,
  json,
} from "./lib/shared.mts";

import { requireAuth, actorName } from "./lib/auth-guard.mts";
import { logActivity, money } from "./lib/activity.mts";
// Enforced so the workflow can't be skipped by a stray API call - mirrors
// the transitions the board's drag-and-drop allows client-side.
const ALLOWED_ACTIONS_BY_STATUS: Record<string, string[]> = {
  pending: ["approve", "reject", "edit-due-date", "edit-line-items"],
  approved: ["record-payment", "edit-due-date"],
  paid: [],
  rejected: ["reopen"],
};

// The Scheduled stage was removed from the workflow. Any bill still stored
// as "scheduled" from before that change is treated as "approved" (the
// stage it came from, and the one that can still record a payment) - on
// read here, and persisted as approved the next time that bill is written.
function foldLegacyScheduled(bill: Bill): Bill {
  if ((bill.status as string) === "scheduled") bill.status = "approved";
  return bill;
}

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const method = req.method;

  if (method === "GET") {
    const store = getStore(BILLS_STORE);
    const data = await store.get(BILLS_KEY, { type: "json" });
    return json(Array.isArray(data) ? (data as Bill[]).map(foldLegacyScheduled) : []);
  }

  if (method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.vendorName || !Array.isArray(body.lineItems) || !body.lineItems.length) {
      return json({ error: "vendorName and at least one line item are required" }, 400);
    }

    const billDate = body.billDate || new Date().toISOString().slice(0, 10);
    const terms = body.terms || "net-30";
    const clientRequestId = body.clientRequestId ? String(body.clientRequestId) : null;

    let resultBill: Bill | null = null;
    let wasDuplicate = false;
    const by = actorName(req);

    try {
      await transactBlobJSON<Bill[]>(BILLS_STORE, BILLS_KEY, [], (current) => {
        wasDuplicate = false;
        resultBill = null;

        if (clientRequestId) {
          const dup = current.find((b) => b.clientRequestId === clientRequestId);
          if (dup) {
            wasDuplicate = true;
            resultBill = dup;
            return current; // no-op - nothing new to persist
          }
        }

        const now = new Date().toISOString();
        const bill: Bill = {
          id: "bill_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          vendorId: body.vendorId || null,
          vendorName: String(body.vendorName),
          billNumber: String(body.billNumber || ""),
          billDate,
          terms,
          dueDate: body.dueDate || addDays(billDate, daysFromTerms(terms)),
          lineItems: body.lineItems.map((li: any) => ({
            description: String(li.description || ""),
            category: String(li.category || "Uncategorized"),
            amount: Number(li.amount) || 0,
          })),
          amount: 0,
          notes: String(body.notes || ""),
          status: "pending",
          scheduledDate: null,
          payments: [],
          amountPaid: 0,
          balance: 0,
          createdAt: now,
          updatedAt: now,
          history: [{ ts: now, action: "created", by }],
          recurringTemplateId: body.recurringTemplateId || null,
          isEstimated: !!body.isEstimated,
          varyFloor: body.varyFloor != null ? Number(body.varyFloor) : null,
          varyCeiling: body.varyCeiling != null ? Number(body.varyCeiling) : null,
          clientRequestId,
        };
        recompute(bill);
        assertBillInvariant(bill);

        resultBill = bill;
        return [...current, bill];
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to create bill" }, status);
    }

    if (!wasDuplicate && resultBill) {
      const b = resultBill as Bill;
      await logActivity(req, "Entered bill", `${b.vendorName}${b.billNumber ? " #" + b.billNumber : ""} · ${money(b.amount)}`, { billId: b.id });
    }
    return json(resultBill, wasDuplicate ? 200 : 201);
  }

  if (method === "PUT") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { id, action } = body;
    if (!id || !action) return json({ error: "id and action are required" }, 400);

    let resultBill: Bill | null = null;
    const by = actorName(req);

    try {
      await transactBlobJSON<Bill[]>(BILLS_STORE, BILLS_KEY, [], (current) => {
        const bill = current.find((b) => b.id === id);
        if (!bill) throw new HttpError(404, "Bill not found");
        foldLegacyScheduled(bill);

        const allowed = ALLOWED_ACTIONS_BY_STATUS[bill.status] || [];
        if (!allowed.includes(action)) {
          throw new HttpError(409, `Cannot "${action}" a bill in status "${bill.status}"`);
        }

        const now = new Date().toISOString();

        if (action === "approve") {
          bill.status = "approved";
          bill.history.push({ ts: now, action: "approved", by });
        } else if (action === "reject") {
          bill.status = "rejected";
          bill.history.push({ ts: now, action: "rejected", note: body.note || undefined, by });
        } else if (action === "record-payment") {
          const amount = Number(body.amount);
          if (!amount || amount <= 0) throw new HttpError(400, "A positive payment amount is required");
          if (amount - bill.balance > 0.005) {
            throw new HttpError(
              400,
              `Payment of $${amount.toFixed(2)} exceeds the remaining balance of $${bill.balance.toFixed(2)}`,
            );
          }
          bill.payments.push({
            id: "pmt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            amount,
            date: body.date || now.slice(0, 10),
            method: body.method || "Other",
            note: body.note || undefined,
          });
          recompute(bill);
          if (bill.balance <= 0) {
            bill.status = "paid";
            bill.history.push({ ts: now, action: "paid-in-full", note: `$${amount.toFixed(2)}`, by });
          } else {
            bill.history.push({ ts: now, action: "payment-recorded", note: `$${amount.toFixed(2)}`, by });
          }
        } else if (action === "edit-due-date") {
          if (!body.dueDate) throw new HttpError(400, "dueDate is required");
          bill.dueDate = body.dueDate;
          bill.history.push({ ts: now, action: "due-date-edited", note: bill.dueDate, by });
        } else if (action === "edit-line-items") {
          // Mainly for estimated (isEstimated) bills auto-generated by a
          // variable-amount recurring template - correct the guessed amount
          // to the real invoiced one before approving.
          if (!Array.isArray(body.lineItems) || !body.lineItems.length) {
            throw new HttpError(400, "At least one line item is required");
          }
          bill.lineItems = body.lineItems.map((li: any) => ({
            description: String(li.description || ""),
            category: String(li.category || "Uncategorized"),
            amount: Number(li.amount) || 0,
          }));
          bill.history.push({ ts: now, action: "line-items-edited", by });
        } else if (action === "reopen") {
          bill.status = "pending";
          bill.history.push({ ts: now, action: "reopened", by });
        }

        recompute(bill);
        assertBillInvariant(bill);
        bill.updatedAt = now;
        resultBill = bill;
        return current;
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to update bill" }, status);
    }

    if (resultBill) {
      const b = resultBill as Bill;
      const verb: Record<string, string> = {
        approve: "Approved bill", reject: "Rejected bill", "record-payment": "Recorded bill payment",
        "edit-due-date": "Changed bill due date", "edit-line-items": "Edited bill amounts", reopen: "Reopened bill",
      };
      const extra = action === "record-payment" ? ` · paid ${money(body.amount)}${b.status === "paid" ? " (paid in full)" : ""}` : "";
      await logActivity(req, verb[action] || `Bill: ${action}`, `${b.vendorName}${b.billNumber ? " #" + b.billNumber : ""} · ${money(b.amount)}${extra}`, { billId: b.id });
    }
    return json(resultBill);
  }

  if (method === "DELETE") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id query param is required" }, 400);

    let found = false;
    let gone: Bill | null = null;
    try {
      await transactBlobJSON<Bill[]>(BILLS_STORE, BILLS_KEY, [], (current) => {
        gone = current.find((b) => b.id === id) || null;
        found = !!gone;
        if (!found) throw new HttpError(404, "Bill not found");
        return current.filter((b) => b.id !== id);
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to delete bill" }, status);
    }

    const g = gone as Bill | null;
    await logActivity(req, "Deleted bill", g ? `${g.vendorName}${g.billNumber ? " #" + g.billNumber : ""} · ${money(g.amount)}` : id, { billId: id });
    return json({ ok: true, id });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = {
  path: "/.netlify/functions/bills",
};
