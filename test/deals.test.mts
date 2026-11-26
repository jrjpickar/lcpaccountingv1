import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../netlify/functions/deals.mts';
import { fetchAllOpportunities } from '../netlify/functions/lib/ghl.mts';
import { signSession, OWNER_EMAIL } from '../netlify/shared/auth.ts';
process.env.LEDGER_PASSWORD = 'test-password-long';

const opp = (id: string, extra: any = {}) => ({ id, name: 'Deal ' + id, status: 'won', pipelineStageId: 's1', monetaryValue: 1000, lastStatusChangeAt: '2026-11-03T18:00:00Z', ...extra });

test('opportunity search pages with `page`, never start_after, and stops on a short page', async () => {
  const seen: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u)); seen.push(url.search);
    assert.equal(url.searchParams.has('start_after'), false);
    assert.equal(url.searchParams.has('start_after_id'), false);
    const page = Number(url.searchParams.get('page'));
    const n = page === 1 ? 100 : 30;
    const opportunities = Array.from({ length: n }, (_, i) => opp(page + '-' + i));
    return new Response(JSON.stringify({ opportunities, meta: { total: 130 } }), { status: 200 });
  }) as any;
  try {
    const r = await fetchAllOpportunities('t', 'loc', { pipelineId: 'p', status: 'won' });
    assert.equal(r.opportunities.length, 130); assert.equal(seen.length, 2); assert.equal(r.truncated, false);
  } finally { globalThis.fetch = orig; }
});

test('deals GET returns only won deals from acq + retail pipelines with the GHL close date', async () => {
  process.env.GHL_PIT_TOKEN = 't'; process.env.GHL_LOCATION_ID = 'loc';
  const orig = globalThis.fetch;
  globalThis.fetch = (async (u: any) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith('/pipelines')) return new Response(JSON.stringify({ pipelines: [
      { id: 'pa', name: 'Acquisitions', stages: [{ id: 's1', name: 'Closed', position: 0 }] },
      { id: 'pr', name: 'Retail Dispo', stages: [{ id: 's2', name: 'Sold', position: 0 }] },
      { id: 'px', name: 'Buyers', stages: [] },
    ] }));
    assert.equal(url.searchParams.get('status'), 'won');
    const pid = url.searchParams.get('pipeline_id');
    assert.notEqual(pid, 'px');
    const opportunities = pid === 'pa'
      ? [opp('a1', { closedDate: '2026-10-15T07:00:00Z' }), opp('a2', { status: 'open' })]
      : [opp('r1', { pipelineStageId: 's2' })];
    return new Response(JSON.stringify({ opportunities, meta: { total: opportunities.length } }));
  }) as any;
  try {
    const { token } = await signSession({ id: 'owner', email: OWNER_EMAIL, name: 'Owner' }, 'pin');
    const res = await handler(new Request('https://test/api/deals', { headers: { 'x-ledger-auth': token } }));
    const d: any = await res.json();
    assert.equal(res.status, 200, JSON.stringify(d));
    assert.deepEqual(d.deals.map((x: any) => x.id).sort(), ['a1', 'r1']);
    const a1 = d.deals.find((x: any) => x.id === 'a1');
    assert.equal(a1.closedField, 'closedDate'); assert.equal(a1.closedDate, '2026-10-15'); assert.equal(a1.pipelineKind, 'acquisitions');
    const r1 = d.deals.find((x: any) => x.id === 'r1');
    assert.equal(r1.closedField, 'lastStatusChangeAt'); assert.equal(r1.pipelineKind, 'retail');
    assert.deepEqual(d.pipelines.map((p: any) => p.kind), ['acquisitions', 'retail']);
  } finally { globalThis.fetch = orig; }
});
