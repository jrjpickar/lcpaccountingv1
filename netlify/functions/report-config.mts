// GET/PUT /api/report-config
//
// Persists the Reports tab's custom dashboard layout - an ordered list of
// widgets (see ReportWidget in lib/shared.mts) - in its own Netlify Blobs
// store. This is intentionally simple compared to bills.mts: there's
// no workflow, no invariant beyond "every widget names a known metric and
// a valid size," and a PUT just replaces the whole layout (the dashboard
// customize UI always sends the complete widget list, never a partial
// patch). Still goes through transactBlobJSON so two people editing the
// layout at the same instant don't silently clobber each other - the
// second save re-reads and re-applies against whatever's actually there.
//
// GET falls back to DEFAULT_REPORT_WIDGETS (not an empty array) so a fresh
// deploy shows a populated dashboard instead of a blank one.

import {
  type ReportConfig,
  REPORT_CONFIG_STORE,
  REPORT_CONFIG_KEY,
  DEFAULT_REPORT_WIDGETS,
  HttpError,
  transactBlobJSON,
  json,
} from "./lib/shared.mts";
import { getStore } from "@netlify/blobs";
import { requireAuth } from "./lib/auth-guard.mts";
import { logActivity } from "./lib/activity.mts";

const VALID_SIZES = new Set(["sm", "lg"]);

export default async (req: Request) => {
  const denied = await requireAuth(req);
  if (denied) return denied;

  const method = req.method;

  if (method === "GET") {
    const store = getStore(REPORT_CONFIG_STORE);
    const data = await store.get(REPORT_CONFIG_KEY, { type: "json" });
    const config: ReportConfig =
      data && Array.isArray((data as any).widgets) ? (data as ReportConfig) : { widgets: DEFAULT_REPORT_WIDGETS };
    return json(config);
  }

  if (method === "PUT") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!Array.isArray(body.widgets)) {
      return json({ error: "widgets (array) is required" }, 400);
    }

    for (const w of body.widgets) {
      if (!w || typeof w.metric !== "string" || !w.metric) {
        return json({ error: "Every widget needs a metric" }, 400);
      }
      if (!VALID_SIZES.has(w.size)) {
        return json({ error: `Invalid widget size "${w.size}"` }, 400);
      }
    }

    const widgets = body.widgets.map((w: any, i: number) => ({
      id: String(w.id || `w_${Date.now().toString(36)}_${i}`),
      metric: String(w.metric),
      size: w.size,
    }));

    // Ids of one-time layout migrations the page has already applied (see
    // REPORT_MIGRATIONS in public/index.html) - kept so a widget someone
    // deliberately removed isn't re-added on the next load.
    const migrations: string[] = Array.isArray(body.migrations)
      ? body.migrations.map((m: any) => String(m)).filter(Boolean).slice(0, 100)
      : [];

    let result: ReportConfig | null = null;
    try {
      await transactBlobJSON<ReportConfig>(REPORT_CONFIG_STORE, REPORT_CONFIG_KEY, { widgets: DEFAULT_REPORT_WIDGETS }, () => {
        result = { widgets, migrations };
        return result;
      });
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      return json({ error: err.message || "Failed to save dashboard layout" }, status);
    }

    await logActivity(req, "Changed Reports layout", `${widgets.length} widgets`);
    return json(result);
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config = {
  path: "/.netlify/functions/report-config",
};
