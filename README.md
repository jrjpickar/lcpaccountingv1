# LocalCare Ledger

Accounting dashboard for LocalCare Props LLC, embedded in GHL as a Custom Page.
Deals (live from the GHL acquisitions pipeline), Bills (AP with approvals and
recurring bills), Partners (capital ledger) and Reports (live P&L + wholesale KPIs).

Setup, env vars and how the numbers are counted: **START-HERE.md**.

## Layout
- `public/index.html` - the whole app (no build step)
- `netlify/functions/deals.mts` - GHL pipeline pull + deal records (Netlify Blobs)
- `netlify/functions/partners.mts` - partners, ownership %, contributions/distributions
- `netlify/functions/bills.mts`, `recurring-bills.mts`, `run-recurring-bills.mts` - AP
- `netlify/functions/vendors.mts`, `customers.mts` - GHL contact search (vendor / buyer pickers)
- `netlify/functions/report-config.mts`, `ytd-baseline.mts` - Reports layout, opening baseline
- `netlify/functions/session.mts`, `access.mts`, `lib/auth-guard.mts`, `netlify/shared/auth.ts`,
  `netlify/edge-functions/auth-gate.ts` - GHL sign-in, roles, activity log
