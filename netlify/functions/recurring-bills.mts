// GET/POST/PUT/DELETE /api/recurring-bills
//
// Templates for bills that repeat on a schedule (rent, insurance, a
// subscription, a utility). This function only manages the templates -
// it never creates a Bill itself. The actual bill-on-a-schedule part is
// run-recurring-bills.mts, a Netlify Scheduled Function that reads these
// templates daily and calls generateBillFromTemplate() for any template
// whose nextRunDate has arrived.
//
// A template with isVariable:true has no fixedAmount - instead it carries
// a varyFloor/varyCeiling estimate range (for bills like electricity that
// aren't the same amount every cycle). The scheduled function bills the
// midpoint as an estimate and flags the generated bill so the UI can
// prompt for the real amount before it's approved.
//
// Concurrency: writes go through transactBlobJSON() (lib/shared.mts), which
// uses Netlify Blobs' conditional writes to detect a write from someone
// else - most importantly the run-recurring-bills.mts cron, which updates
// nextRunDate/lastRunDate/active on its own schedule - and retries the
// mutation against fresh data instead of silently overwriting it.

import { getStore } from "@netlify/blobs";
import { type RecurringTemplate, RECURRING_STORE, RECURRING_KEY, HttpError, transactBlobJSON, json } from "./lib/shared.mts";
import { requireAuth, actorName } from "./lib/auth-guard.mts";
import { logActivity, money } from "./lib/activity.mts";

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const method = req.method;
  const url = new URL(req.url);

  if (method === "GET") {
    const store = getStore(RECURRING_STORE);
    const data = await store.get(RECURRING_KEY, { type: "json" });
    return json(Array.isArray(data) ? data : []);
  }

  if (method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.vendorName || !body.description || !body.frequency || !body.startDate) {
      return json({ error: "vendorName, description, frequency, and startDate are required" }, 400);
    }

    const isVariable = !!body.isVariable;
    if (isVariable) {
      const floor = Number(body.varyFloor);
      const ceiling = Number(body.varyCeiling);
      if (!(floor >= 0) || !(ceiling >= 0)) {
        return json({ error: "varyFloor and varyCeiling are required when the amount varies" }, 400);
      }
      if (floor > ceiling) {
        return json({ error: "varyFloor cannot be greater than varyCeiling" }, 400);
      }
    } else if (!(Number(body.fixedAmount) > 0)) {
      return json({ error: "fixedAmount must be a positive number when the amount doesn't vary" }, 400);
    }

    let resultTemplate: RecurringTemplate | null = null;

    try {
      await transactBlobJSON<RecurringTemplate[]>(RECURRING_STORE, RECURRING_KEY, [], (current) => {
        const now = new Date().toISOString();
        const template: RecurringTemplate = {
          id: "recur_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          vendorId: body.vendorId || null,
          vendorName: String(body.vendorName),
          description: String(body.description),
          category: String(body.category || "Uncategorized"),
          billNumberPrefix: String(body.billNumberPrefix || ""),
          terms: body.terms || "net-30",
          frequency: body.frequency,
          startDate: body.startDate,
          endDate: body.endDate || null,
          isVariable,
          fixedAmount: isVariable ? null : Number(body.fixedAmount),
          varyFloor: isVariable ? Number(body.varyFloor) : null,
          varyCeiling: isVariable ? Number(body.varyCeiling) : null,
          active: true,
          nextRunDate: body.startDate,
          lastRunDate: null,
          createdAt: now,
          updatedAt: now,
          history: [{ ts: now, action: "created", by: actorName(req) }],
        };
        resultTemplate = template;
        return [...current, template];
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to create recurring template" }, status);
    }

    await logActivity(req, "Created recurring bill", `${body.vendorName} · ${body.description} · ${body.frequency}`);
    return json(resultTemplate, 201);
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

    let resultTemplate: RecurringTemplate | null = null;

    try {
      await transactBlobJSON<RecurringTemplate[]>(RECURRING_STORE, RECURRING_KEY, [], (current) => {
        const tpl = current.find((t) => t.id === id);
        if (!tpl) throw new HttpError(404, "Recurring template not found");

        const now = new Date().toISOString();

        if (action === "pause") {
          tpl.active = false;
          tpl.history.push({ ts: now, action: "paused", by: actorName(req) });
        } else if (action === "resume") {
          tpl.active = true;
          tpl.history.push({ ts: now, action: "resumed", by: actorName(req) });
        } else {
          throw new HttpError(400, `Unknown action "${action}"`);
        }

        tpl.updatedAt = now;
        resultTemplate = tpl;
        return current;
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to update recurring template" }, status);
    }

    const t = resultTemplate as RecurringTemplate | null;
    if (t) await logActivity(req, action === "pause" ? "Paused recurring bill" : "Resumed recurring bill", `${t.vendorName} · ${t.description}`);
    return json(resultTemplate);
  }

  if (method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id query parameter is required" }, 400);

    try {
      await transactBlobJSON<RecurringTemplate[]>(RECURRING_STORE, RECURRING_KEY, [], (current) => {
        const idx = current.findIndex((t) => t.id === id);
        if (idx === -1) throw new HttpError(404, "Recurring template not found");
        return [...current.slice(0, idx), ...current.slice(idx + 1)];
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to delete recurring template" }, status);
    }

    await logActivity(req, "Deleted recurring bill", id);
    return json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = {
  path: "/.netlify/functions/recurring-bills",
};
