// Shared GHL (LeadConnector) helpers - opportunity search with pagination,
// and the pipeline/stage list - used by deals.mts.

export const GHL_BASE = "https://services.leadconnectorhq.com";
export const GHL_VERSION = "2021-07-28";

const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // safety cap - 20 * 100 = 2,000 opportunities per query, per request

export type OpportunityQuery = {
  pipelineId: string;
  // Omit to pull every stage in the pipeline.
  pipelineStageId?: string;
  // GHL's status filter: "open" | "won" | "lost" | "abandoned" | "all".
  // Omit to use GHL's default (what the Invoices board has always used).
  status?: string;
};

export type OpportunityFetchResult = {
  opportunities: any[];
  // True if MAX_PAGES was hit with more pages still available - any total
  // built from this is an undercount.
  truncated: boolean;
};

export async function fetchAllOpportunities(
  token: string,
  locationId: string,
  query: OpportunityQuery,
): Promise<OpportunityFetchResult> {
  const all: any[] = [];
  let startAfter: string | undefined;
  let startAfterId: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${GHL_BASE}/opportunities/search`);
    url.searchParams.set("location_id", locationId);
    url.searchParams.set("pipeline_id", query.pipelineId);
    if (query.pipelineStageId) url.searchParams.set("pipeline_stage_id", query.pipelineStageId);
    if (query.status) url.searchParams.set("status", query.status);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (startAfter) url.searchParams.set("start_after", startAfter);
    if (startAfterId) url.searchParams.set("start_after_id", startAfterId);

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(
        `GHL API ${res.status} for pipeline ${query.pipelineId}` +
          (query.pipelineStageId ? ` / stage ${query.pipelineStageId}` : "") +
          `: ${await res.text()}`,
      );
    }

    const body: any = await res.json();
    const opps: any[] = body?.opportunities ?? [];
    all.push(...opps);

    if (opps.length < PAGE_LIMIT) break; // fewer than a full page means we're done

    // NOTE: this endpoint validated request params as snake_case
    // (location_id, not locationId) - checking both cases here in case the
    // response's `meta` object mirrors that, or uses camelCase instead.
    const last = opps[opps.length - 1];
    const meta = body?.meta ?? {};
    startAfter = meta.start_after ?? meta.startAfter ?? last?.updatedAt;
    startAfterId = meta.start_after_id ?? meta.startAfterId ?? last?.id;
    if (!startAfterId) break; // no cursor to continue with - stop rather than loop forever
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return { opportunities: all, truncated };
}

export function opportunityValue(opp: any): number {
  const v = Number(opp?.monetaryValue);
  return Number.isFinite(v) ? v : 0;
}

export type GhlStage = { id: string; name: string; position: number };
export type GhlPipeline = { id: string; name: string; stages: GhlStage[] };

// Every pipeline in the location, with its stages in board order.
// Needs the opportunities.readonly scope (same as the search above).
export async function fetchPipelines(token: string, locationId: string): Promise<GhlPipeline[]> {
  const url = new URL(`${GHL_BASE}/opportunities/pipelines`);
  url.searchParams.set("locationId", locationId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GHL API ${res.status} listing pipelines: ${await res.text()}`);
  const body: any = await res.json();
  return (body?.pipelines ?? []).map((p: any) => ({
    id: String(p.id),
    name: String(p.name || ""),
    stages: (p.stages ?? [])
      .map((st: any, i: number) => ({ id: String(st.id), name: String(st.name || ""), position: Number(st.position ?? i) }))
      .sort((a: GhlStage, b: GhlStage) => a.position - b.position),
  }));
}
