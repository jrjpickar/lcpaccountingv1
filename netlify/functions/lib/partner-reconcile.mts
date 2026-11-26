// Partner capital reconciled against Relay.
//
// Relay is the starting point: every settled Owner contribution / Owner
// distribution row on Bank & P&L becomes a capital line for the partner its
// owner maps to. Manual Partners entries are matched to those rows so the
// same money is never counted twice:
//   - auto: same partner, same type, same amount, dates within 7 days
//   - manual link: entry.relayId = a Relay row id (amount may differ; flagged)
//   - forced none: entry.relayId = "" (money that never touched Relay)
// Result lines are "matched" (counted once, at the Relay amount), "relay"
// (Relay only) or "manual" (Partners entry only).
import type { PartnerMember, PartnerEntry } from "./shared.mts";

export const BANK_OWNERS = ["Art", "Bryce", "Jesse"] as const;
const DAY = 86400000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dayGap = (a: string, b: string) => Math.abs(Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / DAY;

// "Art" <-> "Arturo Vazquez", "Jesse" <-> "Jesse Pickar": by first name.
export function ownerForMember(m: PartnerMember): string {
  const first = String(m.name || "").trim().split(/\s+/)[0].toLowerCase();
  return BANK_OWNERS.find((o) => first.startsWith(o.toLowerCase()) || o.toLowerCase().startsWith(first)) || "";
}
export function memberForOwner(owner: string, members: PartnerMember[]): PartnerMember | null {
  if (!owner) return null;
  return members.find((m) => ownerForMember(m) === owner) || null;
}

export type RelayCapital = {
  id: string; date: string; amount: number; type: "contribution" | "distribution"; owner: string; memberId: string | null;
  account: string; payee: string; reference: string; contribType?: string; vendor?: string;
};
export type CapitalLine = {
  key: string; kind: "matched" | "relay" | "manual"; link: "auto" | "manual" | null;
  memberId: string | null; type: "contribution" | "distribution"; date: string; amount: number;
  relay: RelayCapital | null; entry: PartnerEntry | null; amountDiff: number;
};

export function relayCapital(rows: any[], members: PartnerMember[]): RelayCapital[] {
  return rows
    .filter((t) => t.status === "SETTLED" && ((t.category === "Owner contribution" && t.cents > 0) || (t.category === "Owner distribution" && t.cents < 0)))
    .map((t) => ({
      id: t.id, date: t.date, amount: r2(Math.abs(t.cents) / 100), type: t.category === "Owner contribution" ? "contribution" as const : "distribution" as const,
      owner: t.owner || "", memberId: memberForOwner(t.owner || "", members)?.id || null,
      account: t.account, payee: t.payee, reference: t.reference || "",
      contribType: t.contribType, vendor: t.contribType === "paid" ? t.pairPayee || t.contribNote || "" : "",
    }));
}

export function reconcileCapital(members: PartnerMember[], entries: PartnerEntry[], relay: RelayCapital[]) {
  const byRelay = new Map(relay.map((r) => [r.id, r]));
  const used = new Set<string>();
  const lines: CapitalLine[] = [];
  const pending: PartnerEntry[] = [];
  // Manual links first, so auto-matching can't take a row someone picked.
  for (const e of entries) {
    const rid = (e as any).relayId;
    if (typeof rid === "string" && rid) {
      const r = byRelay.get(rid);
      if (r && !used.has(r.id)) { used.add(r.id); lines.push(line("matched", "manual", e, r)); continue; }
    }
    pending.push(e);
  }
  for (const e of pending) {
    const rid = (e as any).relayId;
    if (rid === "" ) { lines.push(line("manual", null, e, null)); continue; }
    let best: RelayCapital | null = null, gap = 99;
    for (const r of relay) {
      if (used.has(r.id) || r.memberId !== e.memberId || r.type !== e.type || Math.abs(r.amount - e.amount) > 0.005) continue;
      const g = dayGap(r.date, e.date);
      if (g <= 7 && g < gap) { best = r; gap = g; }
    }
    if (best) { used.add(best.id); lines.push(line("matched", "auto", e, best)); }
    else lines.push(line("manual", null, e, null));
  }
  for (const r of relay) if (!used.has(r.id)) lines.push(line("relay", null, null, r));
  lines.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);

  const totals: Record<string, { contributed: number; distributed: number; fromRelay: number; manualOnly: number; matched: number }> = {};
  for (const m of members) totals[m.id] = { contributed: 0, distributed: 0, fromRelay: 0, manualOnly: 0, matched: 0 };
  const unassigned = { contributed: 0, distributed: 0, count: 0 };
  for (const l of lines) {
    const t = l.memberId ? totals[l.memberId] : null;
    if (!t) { if (l.type === "contribution") unassigned.contributed += l.amount; else unassigned.distributed += l.amount; unassigned.count++; continue; }
    if (l.type === "contribution") t.contributed += l.amount; else t.distributed += l.amount;
    if (l.kind === "relay") t.fromRelay++; else if (l.kind === "manual") t.manualOnly++; else t.matched++;
  }
  for (const k of Object.keys(totals)) { totals[k].contributed = r2(totals[k].contributed); totals[k].distributed = r2(totals[k].distributed); }
  unassigned.contributed = r2(unassigned.contributed); unassigned.distributed = r2(unassigned.distributed);
  return { lines, totals, unassigned };
}

function line(kind: CapitalLine["kind"], link: CapitalLine["link"], e: PartnerEntry | null, r: RelayCapital | null): CapitalLine {
  // A matched line counts the Relay amount and date: that's the money that moved.
  return {
    key: (e ? e.id : "") + "|" + (r ? r.id : ""), kind, link,
    memberId: e ? e.memberId : r!.memberId, type: e ? e.type : r!.type,
    date: r ? r.date : e!.date, amount: r ? r.amount : e!.amount,
    relay: r, entry: e, amountDiff: e && r ? r2(r.amount - e.amount) : 0,
  };
}
