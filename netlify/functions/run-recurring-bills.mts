// Scheduled function - runs daily on Netlify's own cron, no HTTP call
// needed from the dashboard. Also reachable manually at
// /api/run-recurring-bills (POST) to force a run without waiting for cron,
// which is the easiest way to test this after deploying.
//
// For every active recurring template whose nextRunDate has arrived, this
// generates a Bill (via the same generateBillFromTemplate() the rest of
// the AP backend shares), advances the template to its next occurrence,
// and writes both stores back. A template past its endDate is retired
// (active:false) instead of generating forever.
//
// Catch-up is capped at MAX_CATCHUP_PER_TEMPLATE per run so a template
// that was paused for months doesn't flood the Bills board with backlog
// the moment it's resumed - it catches up gradually, a few runs at a time.
//
// Concurrency: the plan (which templates are due, how many bills each
// generates) is computed once from a snapshot read of the templates store,
// then applied as two separate transactBlobJSON() writes - one to
// BILLS_STORE (appending the generated bills), one to RECURRING_STORE
// (advancing nextRunDate/lastRunDate/active). Each write is individually
// safe against a concurrent writer on the SAME store (a clerk editing a
// bill, or pausing/resuming a template, at the same instant this runs) -
// appending bills is retried against whatever bills exist by the time it
// lands, and the template-side write re-checks each template's nextRunDate/
// active against the freshest data before applying, so a concurrent pause
// or edit made between the snapshot and this write isn't silently
// overwritten. What this can NOT do - short of a real transactional
// database instead of two independent blob stores - is guarantee the two
// writes as a single atomic unit: if the bills write succeeds but the
// templates write then fails after exhausting its retries, next run will
// recompute from the template's stale nextRunDate and could generate a
// duplicate bill for that cycle. That's a rare, bounded edge case (only
// after repeated write contention on that one template) rather than silent
// data loss, and duplicate bills are visible/correctable on the board -
// which is the safer failure mode of the two available here.

import { getStore } from "@netlify/blobs";
import {
  type Bill,
  type RecurringTemplate,
  BILLS_STORE,
  BILLS_KEY,
  RECURRING_STORE,
  RECURRING_KEY,
  todayISO,
  advanceDate,
  generateBillFromTemplate,
  transactBlobJSON,
  isScheduledInvocation,
  isTargetLocalHourNow,
  json,
} from "./lib/shared.mts";

import { requireAuth } from "./lib/auth-guard.mts";
const MAX_CATCHUP_PER_TEMPLATE = 3;

// Pure planning function: given one template's current state and today's
// date, decides how many bills to generate (capped) and what the
// template's fields should become. No I/O - used both to build the bills
// to append and, inside the templates write, to re-derive the same update
// against whatever the freshest template state turns out to be.
function planTemplateRun(tpl: RecurringTemplate, today: string, now: string) {
  const bills: Bill[] = [];
  const history: RecurringTemplate["history"] = [];
  let active = tpl.active;
  let nextRunDate = tpl.nextRunDate;
  let lastRunDate = tpl.lastRunDate;

  if (!active || !nextRunDate) return { bills, history, active, nextRunDate, lastRunDate };

  if (tpl.endDate && nextRunDate > tpl.endDate) {
    active = false;
    history.push({ ts: now, action: "ended", note: "Past its end date" });
    return { bills, history, active, nextRunDate, lastRunDate };
  }

  let iterations = 0;
  while (active && nextRunDate && nextRunDate <= today && iterations < MAX_CATCHUP_PER_TEMPLATE) {
    const bill = generateBillFromTemplate({ ...tpl, nextRunDate }, nextRunDate);
    bills.push(bill);

    lastRunDate = nextRunDate;
    nextRunDate = advanceDate(nextRunDate, tpl.frequency);
    history.push({ ts: now, action: "generated-bill", note: bill.id });
    iterations++;

    if (tpl.endDate && nextRunDate > tpl.endDate) {
      active = false;
      history.push({ ts: now, action: "ended", note: "Past its end date" });
      break;
    }
  }

  return { bills, history, active, nextRunDate, lastRunDate };
}

export default async (req: Request) => {
  const denied = await requireAuth(req, { allowScheduled: true });
  if (denied) return denied;

  // Runs hourly (see the schedule below) but only actually does anything
  // once it's really 6am Pacific (DST-aware - see isTargetLocalHourNow()
  // in lib/shared.mts) - a manual /api/run-recurring-bills hit always
  // proceeds regardless of the hour, so testing doesn't have to wait.
  if ((await isScheduledInvocation(req)) && !isTargetLocalHourNow(6)) {
    return json({ ok: true, skipped: true, reason: "not the target local hour yet" });
  }

  const templatesStore = getStore(RECURRING_STORE);
  const snapshotData = await templatesStore.get(RECURRING_KEY, { type: "json" });
  const snapshot: RecurringTemplate[] = Array.isArray(snapshotData) ? snapshotData : [];

  const today = todayISO();
  const now = new Date().toISOString();

  // Plan once from the snapshot so the generated-bill IDs referenced in a
  // template's history line up with the bills actually appended below.
  const plans = new Map<string, ReturnType<typeof planTemplateRun>>();
  const plannedBills: Bill[] = [];
  for (const tpl of snapshot) {
    const plan = planTemplateRun(tpl, today, now);
    plans.set(tpl.id, plan);
    plannedBills.push(...plan.bills);
  }

  if (plannedBills.length > 0) {
    await transactBlobJSON<Bill[]>(BILLS_STORE, BILLS_KEY, [], (current) => [...current, ...plannedBills]);
  }

  await transactBlobJSON<RecurringTemplate[]>(RECURRING_STORE, RECURRING_KEY, [], (current) =>
    current.map((tpl) => {
      const plan = plans.get(tpl.id);
      // No plan (template created after our snapshot) or nothing changed -
      // leave it untouched.
      if (!plan || (plan.bills.length === 0 && plan.history.length === 0)) return tpl;
      // The template moved since our snapshot (someone paused/resumed it,
      // or it already advanced past what we planned from) - don't reapply
      // a plan computed against stale nextRunDate/active; skip it this run
      // rather than overwrite a concurrent edit. It'll be picked up
      // correctly next run.
      const snapshotTpl = snapshot.find((s) => s.id === tpl.id)!;
      if (tpl.active !== snapshotTpl.active || tpl.nextRunDate !== snapshotTpl.nextRunDate) return tpl;

      return {
        ...tpl,
        active: plan.active,
        nextRunDate: plan.nextRunDate,
        lastRunDate: plan.lastRunDate,
        updatedAt: now,
        history: [...tpl.history, ...plan.history],
      };
    }),
  );

  return json({
    ok: true,
    generated: plannedBills.length,
    billIds: plannedBills.map((b) => b.id),
  });
};

export const config = {
  // Scheduled functions can't declare a custom `path` (Netlify now rejects
  // the deploy if they do) - that's fine here, since a function's default
  // invocation path is already /.netlify/functions/run-recurring-bills,
  // which is exactly what netlify.toml's /api/run-recurring-bills redirect
  // points at.
  //
  // Fires every hour, on the hour (Netlify cron is always UTC, with no
  // concept of a time zone) - the handler above is what actually decides
  // whether to do anything, by checking whether it's really 6am Pacific
  // right now via isTargetLocalHourNow(), which is DST-aware since it goes
  // through Intl's own time zone database. That's the deliberate fix for
  // the previous fixed-UTC-offset schedule silently drifting an hour off
  // Pacific time every time daylight saving flips - see
  // isTargetLocalHourNow()/SCHEDULE_TIMEZONE/SCHEDULE_HOUR in
  // lib/shared.mts if the target zone or hour ever needs to change.
  schedule: "0 * * * *",
};
