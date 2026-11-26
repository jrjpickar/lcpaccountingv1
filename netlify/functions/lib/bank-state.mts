// The stored Relay ledger and the classified view of it, shared by
// bank-transactions.mts (Bank & P&L, Bills insights) and partners.mts
// (capital reconciled against Relay).
import { getStore } from '@netlify/blobs';
import type { BankTransaction } from './bank-csv.mts';
import { seed } from './bank-seed.mts';
import { classify, pairOwnerPaid, type ContribOverride } from './bank-metrics.mts';

export const BANK_STORE = 'ledger-bank-transactions', BANK_KEY = 'ledger';
export type BankState = {
  rows: BankTransaction[]; categories: Record<string, string>; owners?: Record<string, string>;
  sources?: Record<string, string>; contribs?: Record<string, ContribOverride>;
  // Soft delete: hidden everywhere, still counted by the import duplicate check
  // so a re-imported CSV can't bring a deleted row back. Restorable.
  deleted?: Record<string, { by: string; at: string }>;
};
export const bankFallback: BankState = { rows: [], categories: {} };

// Every row ever stored (seed + imports), deleted ones included.
export const allBankRows = (state: BankState) => [...new Map([...seed, ...state.rows].map((t) => [t.id, t])).values()];
export const visibleBankRows = (state: BankState) => { const del = state.deleted || {}; return allBankRows(state).filter((t) => !del[t.id]); };

export function classifiedRows(state: BankState) {
  const manualOwner = state.owners || {};
  return pairOwnerPaid(visibleBankRows(state).map((t) => {
    const rule = classify(t, state.sources);
    return { ...t, ...rule, owner: manualOwner[t.id] ?? rule.owner, category: state.categories[t.id] || rule.category,
      reviewed: !!state.categories[t.id] || !rule.needsReview, classificationSource: state.categories[t.id] ? 'Manual' : 'CSV rule' };
  }), state.contribs || {}).map((t) => (t.id in manualOwner ? { ...t, owner: manualOwner[t.id] } : t));
}

export async function loadBankState(): Promise<BankState> {
  return ((await getStore(BANK_STORE).get(BANK_KEY, { type: 'json', consistency: 'strong' })) as BankState | null) || bankFallback;
}
