import { test } from 'node:test';
import assert from 'node:assert/strict';
import bank from '../netlify/functions/bank-transactions.mts';
import partners from '../netlify/functions/partners.mts';
import { signSession, OWNER_EMAIL } from '../netlify/shared/auth.ts';
import { reconcileCapital, ownerForMember } from '../netlify/functions/lib/partner-reconcile.mts';
process.env.LEDGER_PASSWORD = 'test-password-long';

const header = 'Date,Payee,Account #,Transaction Type,Description,Reference,Status,Amount,Currency,Balance\r\n';
const L = (d: string, payee: string, ref: string, amt: string) => `${d},${payee},,Receive,,${ref},SETTLED,${amt},USD,1000.00\r\n`;

test('owner names map to partners by first name', () => {
  assert.equal(ownerForMember({ id: 'm', name: 'Arturo Vazquez', pct: null }), 'Art');
  assert.equal(ownerForMember({ id: 'm', name: 'Jesse Pickar', pct: null }), 'Jesse');
  assert.equal(ownerForMember({ id: 'm', name: 'Someone Else', pct: null }), '');
});

test('reconcile: auto match, manual link, forced none, relay-only, counted once', () => {
  const members = [{ id: 'm_art', name: 'Arturo Vazquez', pct: 50 }, { id: 'm_jesse', name: 'Jesse Pickar', pct: 50 }];
  const relay: any[] = [
    { id: 'r1', date: '2027-01-05', amount: 500, type: 'contribution', owner: 'Art', memberId: 'm_art' },
    { id: 'r2', date: '2027-01-20', amount: 250, type: 'contribution', owner: 'Art', memberId: 'm_art' },
    { id: 'r3', date: '2027-02-01', amount: 900, type: 'contribution', owner: '', memberId: null },
  ];
  const E = (id: string, amount: number, date: string, extra: any = {}) => ({ id, memberId: 'm_art', type: 'contribution', amount, date, note: '', createdAt: '', ...extra });
  const r = reconcileCapital(members, [E('e1', 500, '2027-01-08'), E('e2', 300, '2027-01-21'), E('e3', 260, '2027-01-25', { relayId: 'r2' }), E('e4', 500, '2027-01-06', { relayId: '' })] as any, relay);
  const by = Object.fromEntries(r.lines.map((l) => [l.key, l]));
  assert.equal(by['e1|r1'].kind, 'matched'); assert.equal(by['e1|r1'].link, 'auto');
  assert.equal(by['e3|r2'].link, 'manual'); assert.equal(by['e3|r2'].amountDiff, -10); assert.equal(by['e3|r2'].amount, 250);
  assert.equal(by['e2|'].kind, 'manual'); assert.equal(by['e4|'].kind, 'manual');
  assert.equal(by['|r3'].kind, 'relay');
  assert.equal(r.totals.m_art.contributed, 500 + 250 + 300 + 500);
  assert.deepEqual(r.unassigned, { contributed: 900, distributed: 0, count: 1 });
});

test('partners API reconciles with Relay; bank delete hides a row, survives re-import, restores; admins only', async () => {
  const user = (await signSession({ id: 'owner', email: OWNER_EMAIL, name: 'Owner' }, 'pin')).token; // PIN = user level
  const admin = (await signSession({ id: 'owner', email: OWNER_EMAIL, name: 'Owner' }, 'ghl')).token; // owner via GHL = senior
  const call = (h: any, path: string, tok: string, body?: any) => h(new Request('https://t' + path, { method: body ? 'POST' : 'GET', headers: { 'x-ledger-auth': tok }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const csv = header + L('01/05/2027', 'Adv Plus Banking', 'ACH Pull', '777.00') + L('01/09/2027', 'Adv Plus Banking', 'ACH Pull', '333.00');
  await call(bank, '/api/bank-transactions', user, { action: 'import', files: [{ name: 'Relay #8661.csv', text: csv }] });
  let p = await (await call(partners, '/api/partners', user, { action: 'add-entry', memberId: 'm_art', type: 'contribution', amount: 777, date: '2027-01-04', note: 'Jan funding' })).json();
  const line = (pp: any, amt: number) => pp.lines.find((l: any) => l.amount === amt && l.date.startsWith('2027'));
  assert.equal(line(p, 777).kind, 'matched'); assert.equal(line(p, 333).kind, 'relay'); assert.equal(line(p, 333).memberId, 'm_art');
  assert.equal(p.members.find((m: any) => m.id === 'm_art').bankOwner, 'Art');
  const entryId = line(p, 777).entry.id, relay333 = line(p, 333).relay.id;
  // edit: mark not in Relay -> both lines show separately
  p = await (await call(partners, '/api/partners', user, { action: 'update-entry', id: entryId, relayId: '' })).json();
  assert.equal(p.lines.filter((l: any) => l.amount === 777 && l.date.startsWith('2027')).length, 2);
  // edit amount + link to the 333 row by hand
  p = await (await call(partners, '/api/partners', user, { action: 'update-entry', id: entryId, amount: 330, relayId: relay333 })).json();
  const linked = p.lines.find((l: any) => l.entry && l.entry.id === entryId);
  assert.equal(linked.link, 'manual'); assert.equal(linked.amountDiff, 3);
  // delete: users can't, admins can
  assert.equal((await call(bank, '/api/bank-transactions', user, { action: 'delete', ids: [relay333] })).status, 403);
  assert.equal((await call(bank, '/api/bank-transactions', admin, { action: 'delete', ids: [relay333] })).status, 200);
  let b = await (await call(bank, '/api/bank-transactions', user)).json();
  assert.ok(!b.rows.some((t: any) => t.id === relay333)); assert.ok(b.deleted.some((t: any) => t.id === relay333));
  p = await (await call(partners, '/api/partners', user)).json();
  assert.equal(p.lines.find((l: any) => l.entry && l.entry.id === entryId).kind, 'manual'); // its Relay row is gone
  const r = await (await call(bank, '/api/bank-transactions', user, { action: 'import', files: [{ name: 'Relay #8661.csv', text: csv }] })).json();
  assert.equal(r.added, 0);
  await call(bank, '/api/bank-transactions', admin, { action: 'restore', ids: [relay333] });
  b = await (await call(bank, '/api/bank-transactions', user)).json();
  assert.ok(b.rows.some((t: any) => t.id === relay333));
  // categorizing a deleted row is refused
  await call(bank, '/api/bank-transactions', admin, { action: 'delete', ids: [relay333] });
  assert.equal((await call(bank, '/api/bank-transactions', user, { action: 'categorize', ids: [relay333], category: 'Software' })).status, 400);
});
