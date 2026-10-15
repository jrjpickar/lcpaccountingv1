# LocalCare Ledger - start here

Built from Jesse's A2Z Ledger, so setup works the same way. It has the same GHL
sign-in, the same access list and roles, and the same Bills, Recurring and
Reports engine. What changed for wholesaling:

- **Deals tab** (replaces Invoices). The deal stages are pulled live from GHL by
  name: Verbal Acceptance → Offer Sent → Inspection Period → Pending → Closed.
  Click a card to enter the contract price, assignment fee, EMD, buyer, escrow,
  and the fee actually received.
- **Partners tab** (replaces BBSI payroll). Tracks the ownership split, capital
  contributions and distributions, and estimates each partner's share of net.
- **Wholesale bill categories**, split into lead gen, deal costs and operating
  on the Reports tab.
- **Reports**: fees collected or pending, average fee, EMD at risk, lead gen
  cost per closed deal, the pipeline funnel, a live P&L, and partner capital.
- All of the A2Z data, the Make webhooks and the invoice PDF generation were
  removed.

## 1. Deploy
New Netlify site from this folder (or a git repo of it). Publish dir `public`,
functions `netlify/functions` (already set in `netlify.toml`).

## 2. GHL
1. **Private Integration token** (Settings → Integrations → Private
   Integrations) on the LocalCare location. Give it these scopes:
   `opportunities.readonly`, `contacts.readonly`, `users.readonly`.
2. **Marketplace app** (private): add a **Custom Page** pointing at the Netlify
   URL, copy its **Shared Secret**, and install it on the LocalCare location.

## 3. Netlify environment variables (then redeploy)
| Variable | Needed? | What |
|---|---|---|
| `GHL_PIT_TOKEN` | Required | Token from 2.1 |
| `GHL_LOCATION_ID` | Required | LocalCare sub-account id |
| `GHL_APP_SHARED_SECRET` | Required | Shared Secret from 2.2 |
| `SENIOR_ADMINS` | Recommended | Jesse's GHL login email (comma-separate more). `brycetooley@gmail.com` is always senior. **If Bryce's GHL login uses a different email, add it here.** |
| `LEDGER_PIN` | Optional | 4-12 digits. Lets listed people sign in outside GHL (user level only) |
| `DEALS_PIPELINE_ID` | Optional | Only needed if the pipeline isn't found automatically |
| `DEAL_STAGES` | Optional | Comma-separated stage names. Default: `Verbal Acceptance,Offer Sent,Inspection Period,Pending,Closed` |
| `CLOSED_STAGE` | Optional | Defaults to `Closed` |

If a GHL stage gets renamed, update `DEAL_STAGES`. If the pipeline isn't found,
the Deals tab lists the pipelines it did find.

## 4. First run
1. Open the Ledger from the GHL left menu. You're signed in as senior admin.
2. Go to **Access** → add the team.
3. Go to **Partners** → **Edit partners & split** → set Jesse's and Art's %.
4. Load existing numbers: past expenses go in as **Bills** (record the payment
   so they count), past fees go on each **Deal**, and capital goes in as
   **Partner entries**. For anything older with no deal or bill to attach it
   to, use **Setup → Opening baseline**.

## How the money is counted
- **Revenue** = the fee received, on the date it was received (cash basis).
- **Deal costs** = our closing costs and forfeited EMD (both entered on the
  deal), plus bills tagged Title & Escrow or Inspections & Appraisals.
- **Lead gen** = bills tagged Lead Lists & Data, Skip Tracing, SMS & Dialer,
  Marketing & Ads or Direct Mail.
- **Partner contributions and distributions** are capital, so they never touch
  the P&L.
- Bills count when they're **paid** (record the payment), unless the baseline
  is set to accrual.

## Tests
`npm test` covers sign-in, roles, the deals pull (GHL mocked) and partner
permissions.

Sign-in, Bills, recurring bills and the Reports layout engine are unchanged
from the A2Z Ledger, so its README still applies to those parts.
