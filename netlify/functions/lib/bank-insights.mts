// Read-only insights from the Relay rows, shown on the Bills tab:
//   - subscriptions: vendors charged on a steady cadence, with average and
//     latest charge, a monthly equivalent and the next expected due date
//   - usage vendors: frequent top-ups with no fixed cycle (Twilio-style),
//     shown as an average monthly spend instead of a due date
//   - contributions: owner contributions broken down by partner, by how the
//     money came in (cash into the account vs a vendor paid personally) and
//     by month
// Everything here is derived on each GET from the classified rows, so a new
// Relay import updates it with no extra state.

const DAY = 86400000;
const toDay = (d: string) => Date.parse(d + "T00:00:00Z") / DAY;
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export type InsightRow = {
  id: string; account: string; date: string; payee: string; status: string; cents: number;
  category: string; owner?: string; pairId?: string | null; ownerPaid?: boolean; pairPayee?: string;
  contribType?: "paid" | "deposited"; contribSource?: "auto" | "manual"; contribNote?: string; reference?: string; description?: string;
};

const NOT_SPEND = new Set(["Transfer", "Owner contribution", "Owner distribution", "Revenue", "Other income", "Uncategorized"]);
const CADENCES = [
  { key: "weekly", days: 7, lo: 5, hi: 9 },
  { key: "biweekly", days: 14, lo: 12, hi: 17 },
  { key: "monthly", days: 30.44, lo: 24, hi: 38 },
  { key: "quarterly", days: 91.3, lo: 80, hi: 100 },
  { key: "yearly", days: 365.25, lo: 340, hi: 390 },
] as const;
type Cadence = (typeof CADENCES)[number];

export function vendorKey(payee: string): string {
  return String(payee || "").toLowerCase().replace(/[^a-z]+/g, " ").replace(/\b(llc|inc|co|corp|com|ltd)\b/g, " ").replace(/\s+/g, " ").trim();
}

function addMonths(date: string, n: number): string {
  const y = +date.slice(0, 4), m = +date.slice(5, 7) - 1 + n, d = +date.slice(8, 10);
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
function nextDate(last: string, c: Cadence, n = 1): string {
  if (c.key === "monthly") return addMonths(last, n);
  if (c.key === "quarterly") return addMonths(last, 3 * n);
  if (c.key === "yearly") return addMonths(last, 12 * n);
  return fromDay(toDay(last) + c.days * n);
}

// One charge series (whole vendor, or one price tier of a vendor) -> cadence.
function fitCadence(dates: string[]): Cadence | null {
  const days = [...new Set(dates)].map(toDay).sort((a, b) => a - b);
  if (days.length < 2) return null;
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const med = median(gaps);
  const c = CADENCES.find((x) => med >= x.lo && med <= x.hi);
  if (!c) return null;
  const inBand = gaps.filter((g) => g >= c.lo && g <= c.hi).length;
  // Two charges are enough for monthly or longer; otherwise most gaps must fit.
  if (gaps.length === 1) return c.days >= 24 ? c : null;
  return inBand / gaps.length >= 0.7 ? c : null;
}

export type Subscription = {
  key: string; vendor: string; category: string; accounts: string[]; cadence: string;
  charges: number; avgCharge: number; lastCharge: number; minCharge: number; maxCharge: number; variable: boolean;
  expectedCharge: number; monthlyCost: number; firstDate: string; lastDate: string; dayOfMonth: number | null;
  nextDue: string; status: "upcoming" | "awaiting-import" | "missed" | "stale"; paidBy: string[]; history: { date: string; amount: number }[];
};
export type UsageVendor = { key: string; vendor: string; category: string; charges: number; avgCharge: number; avgMonthly: number; lastDate: string; months: number };

function buildSub(key: string, vendor: string, rows: InsightRow[], c: Cadence, coverage: Record<string, string>, today: string): Subscription {
  rows = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const amts = rows.map((r) => -r.cents / 100);
  const avg = amts.reduce((s, a) => s + a, 0) / amts.length;
  const min = Math.min(...amts), max = Math.max(...amts), last = amts[amts.length - 1];
  const variable = avg > 0 && (max - min) / avg > 0.1;
  // Expected next charge: the latest price if the last two match, else the recent average.
  const recent = amts.slice(-3);
  const expected = amts.length >= 2 && Math.abs(amts[amts.length - 1] - amts[amts.length - 2]) < 0.01 ? last : recent.reduce((s, a) => s + a, 0) / recent.length;
  const lastDate = rows[rows.length - 1].date;
  const accounts = [...new Set(rows.map((r) => r.account))];
  // Statements only cover up to the latest imported date for the account.
  const covered = accounts.map((a) => coverage[a] || "").sort().pop() || lastDate;
  let next = nextDate(lastDate, c);
  let status: Subscription["status"] = "upcoming";
  if (next <= covered) {
    const missed = Math.floor((toDay(covered) - toDay(lastDate)) / c.days);
    status = missed >= 2 ? "stale" : "missed";
    if (status === "missed") { let n = 1; while (next <= covered && n < 24) next = nextDate(lastDate, c, ++n); }
  } else if (next < today) status = "awaiting-import";
  const cats = rows.map((r) => r.category);
  const category = cats.sort((a, b) => cats.filter((x) => x === b).length - cats.filter((x) => x === a).length)[0];
  return {
    key, vendor, category, accounts, cadence: c.key, charges: rows.length,
    avgCharge: r2(avg), lastCharge: r2(last), minCharge: r2(min), maxCharge: r2(max), variable,
    expectedCharge: r2(expected), monthlyCost: r2(expected * (30.44 / c.days)),
    firstDate: rows[0].date, lastDate, dayOfMonth: c.key === "monthly" ? +lastDate.slice(8, 10) : null,
    nextDue: next, status,
    paidBy: [...new Set(rows.filter((r) => r.ownerPaid && r.owner).map((r) => r.owner!))],
    history: rows.slice(-12).map((r) => ({ date: r.date, amount: r2(-r.cents / 100) })),
  };
}

export function detectSubscriptions(rows: InsightRow[], today: string) {
  const coverage: Record<string, string> = {};
  for (const r of rows) if (!coverage[r.account] || r.date > coverage[r.account]) coverage[r.account] = r.date;
  const spend = rows.filter((r) => r.cents < 0 && r.status !== "DECLINED" && !NOT_SPEND.has(r.category));
  const byVendor = new Map<string, InsightRow[]>();
  for (const r of spend) { const k = vendorKey(r.payee); if (k) (byVendor.get(k) || byVendor.set(k, []).get(k)!).push(r); }

  const subscriptions: Subscription[] = [];
  const usage: UsageVendor[] = [];
  const subIds = new Set<string>();
  for (const [key, list] of byVendor) {
    const vendor = list[list.length - 1].payee;
    const whole = fitCadence(list.map((r) => r.date));
    // One charge per cycle across the whole vendor: a subscription even if the price moves.
    if (whole && new Set(list.map((r) => r.date.slice(0, 7))).size >= list.length * 0.8) {
      const s = buildSub(key, vendor, list, whole, coverage, today); subscriptions.push(s); list.forEach((r) => subIds.add(r.id)); continue;
    }
    // Otherwise look for a fixed-price tier inside the vendor (a plan plus one-off add-ons).
    const tiers: InsightRow[][] = [];
    for (const r of [...list].sort((a, b) => a.cents - b.cents)) {
      const t = tiers.find((g) => Math.abs(g[0].cents - r.cents) <= Math.max(200, Math.abs(g[0].cents) * 0.05));
      if (t) t.push(r); else tiers.push([r]);
    }
    let found = false;
    for (const t of tiers) {
      if (t.length < 3) continue;
      const c = fitCadence(t.map((r) => r.date));
      if (c && c.days >= 24) { subscriptions.push(buildSub(key, vendor, t, c, coverage, today)); t.forEach((r) => subIds.add(r.id)); found = true; }
    }
    // Frequent charges with no cycle: usage-based (top-ups, metered billing).
    const rest = list.filter((r) => !subIds.has(r.id));
    const restDays = [...new Set(rest.map((r) => r.date))].map(toDay).sort((a, b) => a - b);
    const restGap = restDays.length > 1 ? median(restDays.slice(1).map((d, i) => d - restDays[i])) : 99;
    if (!found && rest.length >= 4 && restGap < 20) {
      const months = new Set(rest.map((r) => r.date.slice(0, 7))).size;
      const total = rest.reduce((s, r) => s - r.cents / 100, 0);
      usage.push({ key, vendor, category: rest[0].category, charges: rest.length, avgCharge: r2(total / rest.length), avgMonthly: r2(total / Math.max(1, months)), lastDate: rest.map((r) => r.date).sort().pop()!, months });
    }
  }
  subscriptions.sort((a, b) => (a.status === "stale" ? 1 : 0) - (b.status === "stale" ? 1 : 0) || a.nextDue.localeCompare(b.nextDue));
  usage.sort((a, b) => b.avgMonthly - a.avgMonthly);

  // Actual subscription spend per month, for the average over the last 3 complete months.
  const latest = Object.values(coverage).sort().pop() || today;
  const lastComplete = addMonths(latest.slice(0, 7) + "-01", -1).slice(0, 7);
  const byMonth: Record<string, number> = {};
  for (const r of spend) if (subIds.has(r.id)) byMonth[r.date.slice(0, 7)] = (byMonth[r.date.slice(0, 7)] || 0) - r.cents / 100;
  const window = [0, 1, 2].map((i) => addMonths(lastComplete + "-01", -i).slice(0, 7));
  const avgMonthlyActual = r2(window.reduce((s, m) => s + (byMonth[m] || 0), 0) / 3);
  const active = subscriptions.filter((s) => s.status !== "stale");
  return {
    subscriptions, usage, coverage,
    summary: {
      active: active.length,
      monthlyRunRate: r2(active.reduce((s, x) => s + x.monthlyCost, 0)),
      avgMonthlyActual, avgWindow: window.slice().reverse(),
      usageMonthly: r2(usage.reduce((s, u) => s + u.avgMonthly, 0)),
      byMonth: Object.fromEntries(Object.entries(byMonth).sort().map(([k, v]) => [k, r2(v)])),
    },
  };
}

// Owner contributions as the P&L reconciled them (auto-matched to vendor
// charges, or cash in), with any partner edits applied, plus candidate
// vendor charges for each one so a partner can re-point "owner paid".
export function contributionBreakdown(rows: InsightRow[]) {
  const contribs = rows.filter((r) => r.category === "Owner contribution" && r.cents > 0 && r.status === "SETTLED");
  const expenses = rows.filter((r) => r.cents < 0 && r.status !== "DECLINED" && !["Transfer", "Owner contribution", "Owner distribution", "Revenue", "Other income"].includes(r.category));
  const pairedExpense = new Map<string, string>(); // pairId -> expense id
  for (const e of expenses) if (e.pairId && e.ownerPaid) pairedExpense.set(e.pairId, e.id);
  const owners = new Map<string, any>();
  for (const r of contribs) {
    const k = r.owner || "";
    const o = owners.get(k) || { owner: k, total: 0, cash: 0, paidVendors: 0, count: 0, edited: 0, vendors: {}, byMonth: {}, firstDate: r.date, lastDate: r.date, entries: [] };
    const amt = r.cents / 100;
    const paid = r.contribType === "paid" || (!r.contribType && !!r.pairId);
    o.total += amt; o.count++;
    if (r.contribSource === "manual") o.edited++;
    if (paid) { o.paidVendors += amt; const v = r.pairPayee || r.contribNote || "Vendor"; o.vendors[v] = (o.vendors[v] || 0) + amt; }
    else o.cash += amt;
    const m = r.date.slice(0, 7); o.byMonth[m] = (o.byMonth[m] || 0) + amt;
    if (r.date < o.firstDate) o.firstDate = r.date;
    if (r.date > o.lastDate) o.lastDate = r.date;
    const expenseId = r.pairId ? pairedExpense.get(r.pairId) || null : null;
    const candidates = expenses
      .filter((e) => e.cents === -r.cents && (!e.pairId || e.pairId === r.pairId) && Math.abs(toDay(e.date) - toDay(r.date)) <= 30)
      .sort((a, b) => Math.abs(toDay(a.date) - toDay(r.date)) - Math.abs(toDay(b.date) - toDay(r.date)))
      .slice(0, 6)
      .map((e) => ({ id: e.id, date: e.date, payee: e.payee, account: e.account, amount: r2(-e.cents / 100), category: e.category }));
    o.entries.push({
      id: r.id, date: r.date, amount: r2(amt), account: r.account, payee: r.payee, reference: r.reference || "",
      type: paid ? "paid" : "deposited", source: r.contribSource || "auto", vendor: paid ? r.pairPayee || r.contribNote || "" : "",
      expenseId, note: r.contribNote || "", candidates,
    });
    owners.set(k, o);
  }
  const list = [...owners.values()].map((o) => ({
    ...o, total: r2(o.total), cash: r2(o.cash), paidVendors: r2(o.paidVendors),
    vendors: Object.fromEntries(Object.entries(o.vendors as Record<string, number>).map(([k, v]) => [k, r2(v)])),
    byMonth: Object.fromEntries(Object.entries(o.byMonth as Record<string, number>).sort().map(([k, v]) => [k, r2(v)])),
    entries: o.entries.sort((a: any, b: any) => b.date.localeCompare(a.date)),
  })).sort((a, b) => (a.owner ? 0 : 1) - (b.owner ? 0 : 1) || b.total - a.total);
  return { owners: list, total: r2(list.reduce((s, o) => s + o.total, 0)), cash: r2(list.reduce((s, o) => s + o.cash, 0)), paidVendors: r2(list.reduce((s, o) => s + o.paidVendors, 0)) };
}
