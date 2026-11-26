import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSubscriptions, contributionBreakdown } from '../netlify/functions/lib/bank-insights.mts';
import { seed } from '../netlify/functions/lib/bank-seed.mts';
import { classify, pairOwnerPaid } from '../netlify/functions/lib/bank-metrics.mts';

const row = (date: string, payee: string, dollars: number, extra: any = {}) => ({ id: payee + date + dollars, account: '8661', date, payee, status: 'SETTLED', cents: Math.round(dollars * 100), category: 'Software', ...extra });

test('subscriptions: monthly cadence, price change, plan inside add-ons, usage vendors, next due and status', () => {
  const rows = [
    row('2026-07-04', 'Make', -10.59), row('2026-08-04', 'Make', -10.59), row('2026-09-04', 'Make', -10.59),
    row('2026-07-19', 'BatchLeads', -119), row('2026-08-19', 'BatchLeads', -349), row('2026-09-19', 'BatchLeads', -349),
    row('2026-07-14', 'HighLevel', -297), row('2026-08-14', 'HighLevel', -297), row('2026-09-14', 'HighLevel', -297), row('2026-09-20', 'HighLevel', -97),
    ...[1, 3, 6, 8, 11, 15, 20].map((d) => row('2026-09-' + String(d).padStart(2, '0'), 'Twilio', -20, { category: 'Marketing' })),
    row('2026-03-01', 'Old Tool', -40), row('2026-04-01', 'Old Tool', -40),
    row('2026-09-28', 'Coverage', -1, { category: 'Transfer' }),
  ];
  const d = detectSubscriptions(rows as any, '2026-10-02');
  const by = Object.fromEntries(d.subscriptions.map((s) => [s.vendor, s]));
  assert.equal(by.Make.cadence, 'monthly'); assert.equal(by.Make.nextDue, '2026-10-04'); assert.equal(by.Make.status, 'upcoming');
  assert.equal(by.BatchLeads.expectedCharge, 349); assert.equal(by.BatchLeads.variable, true); assert.equal(by.BatchLeads.avgCharge, 272.33);
  assert.equal(by.HighLevel.charges, 3); assert.equal(by.HighLevel.expectedCharge, 297);
  assert.equal(by['Old Tool'].status, 'stale');
  assert.deepEqual(d.usage.map((u) => u.vendor), ['Twilio']);
  assert.equal(d.summary.active, 3); assert.equal(d.summary.monthlyRunRate, 656.59);
});

test('subscriptions on the real seed: HighLevel plan found, Twilio is usage, nothing double counted', () => {
  const rows = pairOwnerPaid(seed.map((t) => ({ ...t, ...classify(t) })));
  const d = detectSubscriptions(rows as any, '2026-11-25');
  const hl = d.subscriptions.find((s) => s.vendor === 'HighLevel')!;
  assert.equal(hl.expectedCharge, 297); assert.equal(hl.cadence, 'monthly');
  assert.ok(d.usage.some((u) => u.vendor === 'Twilio'));
  assert.ok(!d.subscriptions.some((s) => s.vendor === 'Twilio'));
  const keys = d.subscriptions.map((s) => s.key + s.expectedCharge); assert.equal(new Set(keys).size, keys.length);
});

test('contributions break down by owner, cash vs vendor paid personally, and month', () => {
  const rows = pairOwnerPaid([
    { ...row('2026-11-03', 'Twilio', -300, { reference: 'Personal card - paid by Arturo Vazquez', description: '', category: 'Marketing' }) },
    { ...row('2026-11-03', 'Adv Plus Banking', 300, { reference: 'ACH Pull - Arturo covered Twilio', description: '', category: 'Owner contribution', owner: 'Art' }) },
    { ...row('2026-10-06', 'Adv Plus Banking', 250, { reference: 'ACH Pull', description: '', category: 'Owner contribution', owner: 'Art' }) },
    { ...row('2026-10-13', 'TOTAL CHECKING', 250, { reference: 'ACH Pull', description: '', category: 'Owner contribution', owner: '' }) },
  ] as any);
  const c = contributionBreakdown(rows as any);
  const art = c.owners.find((o) => o.owner === 'Art')!;
  assert.equal(art.total, 550); assert.equal(art.cash, 250); assert.equal(art.paidVendors, 300); assert.deepEqual(art.vendors, { Twilio: 300 });
  assert.deepEqual(art.byMonth, { '2026-10': 250, '2026-11': 300 });
  assert.equal(c.owners.at(-1)!.owner, ''); assert.equal(c.total, 800);
});
