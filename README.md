# 10-K Explorer
**NYU Stern Learning Science Lab**

A client-side web app for intro accounting students to explore and compare key GAAP financial metrics from public company 10-K filings, sourced from SEC EDGAR.

Live app: https://seandiaz-nyu.github.io/10k-explorer/

---

## What it does

- Side-by-side comparison of up to 4 companies
- Pre-built industry peer groups (Airlines, Big Tech, Beverages, etc.)
- Search across S&P 500 companies by name or ticker
- 20 metrics across Income Statement, Balance Sheet, Cash Flow, and derived Ratios —
  14 figures reported directly in the filing, plus 6 computed in the browser
  (free cash flow, gross margin, net margin, current ratio, debt-to-equity, ROE)
- **Five-year history** per company — switch the table from comparing companies
  to showing one company's fiscal years side by side. Ratios and margins are
  recomputed for each year rather than pinned to the latest one.

### A note on stale figures

Companies stop tagging a concept without ever resuming, so a metric's most
recent reported value can be years older than the rest of the filing — S&P
Global last tagged capital expenditures in FY2009. Roughly 40% of companies have
at least one such metric.

Those cells now carry a small `FY####` badge showing the year the figure
actually covers, and derived ratios are computed only from figures matching the
company's headline fiscal year. Free cash flow reads N/A rather than subtracting
a 2009 capital expenditure from a 2025 operating cash flow.

EPS is available for ~97% of companies. It shows N/A for companies with multiple
share classes (Berkshire, Visa, Airbnb), which report EPS per class — EDGAR's
`companyfacts` API only exposes facts that carry no such breakdown.

---

## Current architecture

The app is fully static and hosted on GitHub Pages. There is no backend.

Financial data is **pre-fetched from SEC EDGAR** using a Node.js script (`scripts/fetch-data.js`) and stored as small JSON files in `data/metrics/`. The browser loads these static files directly — no live API calls are made at runtime.

### Automated refresh

`.github/workflows/refresh-data.yml` runs on the 1st of each month, refetches every filer, and commits whatever changed. Nothing needs to be run by hand.

To refresh immediately, use **Actions → Refresh EDGAR data → Run workflow**.

A full pass takes ~17 minutes. Files are only rewritten when the underlying numbers change, so a run that finds no new filings commits nothing.

### Running it locally

```bash
node scripts/fetch-data.js AAPL MSFT      # specific tickers
node scripts/fetch-data.js --all          # every filer in companies.json
node scripts/fetch-data.js --all --force  # ignore the freshness check
node scripts/fetch-data.js --all --years=10   # keep 10 years instead of 5
```

`data/fetch-state.json` records when each company was last checked and whether it reports us-gaap facts at all; the script uses it to skip companies checked within the last 25 days, and to avoid repeatedly re-downloading ETFs and trusts that have no GAAP data to extract.

History costs no extra requests. A `companyfacts` document already contains every year a company has reported, so `--years` only changes how much of it is kept.

### Stored record shape

```jsonc
{
  "ticker": "AAPL",
  "fiscalYear":  2025,                 // headline year, shown in the column header
  "fiscalYears": [2021, …, 2025],      // oldest first
  "metrics": {                         // latest year, with provenance
    "revenue": { "value": …, "year": 2025, "periodEnd": "2025-09-27", "filed": "2025-10-31" }
  },
  "history": {                         // compact series, oldest first
    "revenue": { "2021": …, "2022": …, "2023": …, "2024": …, "2025": … }
  }
}
```

`metrics` holds the latest year and is what the comparison table reads; `history` is a year → value map including that latest year, so each series stands alone. A metric the company did not report in a given year is `null` rather than absent.

A record written before a change to this shape is refetched even if the freshness check would skip it — otherwise the first scheduled run after such a change would skip every company and roll out nothing.

---

## Why real-time EDGAR fetching requires a backend

The ideal version of this app would let students search for **any** public company and fetch its data live from SEC EDGAR. The technical reason this isn't possible in a purely client-side app comes down to two browser security constraints:

**CORS (Cross-Origin Resource Sharing)**
Browsers block JavaScript from fetching data from a different domain unless that domain explicitly permits it. SEC EDGAR (`data.sec.gov`) returns no `Access-Control-Allow-Origin` header on successful responses, and rejects the `OPTIONS` preflight outright with a 403. So the browser refuses to complete the fetch — even though the data is publicly available and the same request succeeds from `curl`.

This is the only hard blocker, and it cannot be worked around from a browser.

> An earlier version of this README also listed EDGAR's `User-Agent` requirement as a blocker, on the grounds that browsers won't let JavaScript set that header. That turns out not to bite: EDGAR only rejects requests with an *empty* User-Agent, and browsers always send their own. A request with an ordinary Chrome User-Agent returns 200. The SEC does ask that automated clients identify themselves, which is why `scripts/fetch-data.js` sets a contact address — but it's a matter of policy, not a technical barrier.

**The fix**, if same-day freshness is ever needed, is a lightweight server-side proxy — a small Node.js/Express endpoint that receives the request from the browser (same origin, no CORS issue), forwards it to EDGAR, and returns the result. Hosting options include Railway, Cloudflare Workers, Stern IT infrastructure, or a university-managed cloud environment (NYU has Azure/AWS agreements).

The monthly refresh above covers most of the need without any of that: a 10-K is an annual document, so the data changes at most once a year per company.

---

## Project structure

```
10k-explorer/
├── index.html
├── css/
│   └── styles.css
├── js/
│   ├── app.js        # State management and event wiring
│   ├── config.js     # Metrics definitions, industry groups, constants
│   ├── edgar.js      # Data loading (static files + in-memory cache)
│   └── ui.js         # All DOM rendering
├── data/
│   ├── companies.json        # Ticker → CIK/name index (all SEC filers)
│   ├── fetch-state.json      # Per-company: last checked, has GAAP data
│   ├── manifest.json         # Timestamp and scope of the last refresh
│   └── metrics/              # Pre-fetched GAAP metrics, one file per ticker
│       ├── AAPL.json
│       ├── MSFT.json
│       └── ...
├── scripts/
│   └── fetch-data.js         # Fetches/refreshes EDGAR data
└── .github/workflows/
    └── refresh-data.yml      # Monthly automated refresh
```
