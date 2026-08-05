# 10-K Explorer
**NYU Stern Learning Science Lab**

A client-side web app for intro accounting students to explore and compare key GAAP financial metrics from public company 10-K filings, sourced from SEC EDGAR.

Live app: https://sternlsl.github.io/10k-explorer/

---

## What it does

- Side-by-side comparison of up to 4 companies
- Pre-built industry peer groups (Airlines, Big Tech, Beverages, etc.)
- Search by name or ticker across **every SEC filer with usable GAAP data** —
  6,803 tickers covering 5,256 distinct companies
- 20 metrics across Income Statement, Balance Sheet, Cash Flow, and derived Ratios —
  14 figures reported directly in the filing, plus 6 computed in the browser
  (free cash flow, gross margin, net margin, current ratio, debt-to-equity, ROE)
- **Five-year history** per company — switch the table from comparing companies
  to showing one company's fiscal years side by side. Ratios and margins are
  recomputed for each year rather than pinned to the latest one.

---

## Data notes and limits

Read this before trusting a number or filing a bug — most surprises here are
properties of EDGAR, not defects in the app.

**Stale figures are marked.** Companies stop tagging a concept and never resume,
so a metric's most recent reported value can be years older than the rest of the
filing — S&P Global last tagged capital expenditures in FY2009. Roughly 40% of
companies have at least one such metric.

Those cells carry a small `FY####` badge showing the year the figure actually
covers, and derived ratios are computed only from figures matching the company's
headline fiscal year. Free cash flow reads N/A rather than subtracting a 2009
capital expenditure from a 2025 operating cash flow.

**EPS is missing for multi-class companies.** Available for ~97% of companies. It
shows N/A for companies with several share classes (Berkshire, Visa, Airbnb),
which report EPS per class — `companyfacts` only exposes facts that carry no such
breakdown.

**About 29% of SEC filers have no usable data.** ETFs, trusts, and foreign
private issuers reporting under IFRS publish no `us-gaap` facts. They are
recorded in `data/fetch-state.json` and skipped for 180 days rather than retried
every run.

**Search shows bonds and preferred shares.** Searching "AT&T" returns `T`, `TBB`
(a bond), `T-PA`, and `T-PC`. 1,547 of the 6,803 files are the same company under
another ticker.

These are kept deliberately. Security type cannot be inferred from ticker shape:
`BRKR` is Bruker Corporation's common stock while `MGR` is an Affiliated Managers
bond, and `MGR` carries its issuer's name in the SEC index. Any filter aggressive
enough to drop the bonds also drops real companies. The app matches on CIK, so
the same company can never occupy two columns — see `addCompany` in
[`js/app.js`](js/app.js).

**No narrative content.** Management discussion, risk factors, footnotes, and the
auditor's report are not in EDGAR's structured data at all. They live in the
filing documents, a separate and much larger corpus this app does not touch.

**Amended annual reports are excluded.** `10-K/A` is a distinct form string, so a
company that corrects figures by amendment rather than through the next year's
comparatives will not be picked up.

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

## Why there is no backend

A browser cannot fetch from `data.sec.gov` directly. EDGAR returns no
`Access-Control-Allow-Origin` header on successful responses and rejects the
`OPTIONS` preflight with a 403, so the browser refuses the request even though
the same call succeeds from `curl`. This is a browser security rule (CORS) and
cannot be worked around from client-side code.

**That restriction applies only to browsers.** The scheduled refresh runs on
GitHub's servers, where CORS has never applied. So the app does fetch live from
EDGAR — on a schedule, into static files, rather than from the student's browser
on demand.

> An earlier version of this README also listed EDGAR's `User-Agent` requirement
> as a blocker, on the grounds that browsers won't let JavaScript set that header.
> Testing showed that isn't so: EDGAR only rejects requests with an *empty*
> User-Agent, and browsers always send their own. A request with an ordinary
> Chrome User-Agent returns 200. The SEC does ask that automated clients identify
> themselves, which is why `scripts/fetch-data.js` sets a contact address — a
> matter of policy, not a technical barrier.

### Would a proxy server help?

Not for anything the app currently does. Once the scheduled job covers every
filer, a live proxy adds very little:

| Need | Needs a server? |
|---|---|
| Reaching EDGAR at all | No — the scheduled job already does |
| Covering more companies | No — coverage is complete |
| Fresher data | No — change the cron frequency |
| Multi-year history | No — already stored statically |
| Quarterly (10-Q) data | No — roughly 4x the corpus, but no new infrastructure |
| **Any of the ~500 line items on demand** | **Yes** |

The last row is the real case. Apple alone reports 503 distinct `us-gaap`
concepts; storing every concept for every company across multiple years is not
feasible. Letting students pull an arbitrary line item requires fetching on
demand, and fetching on demand from a browser requires a proxy.

If that gets built, **layer it — do not replace the static path.** The site
currently has no runtime dependency that can fail during a class. Keep static
files serving the comparison view and let a server handle only what they cannot.

One prerequisite: the figure-selection rules (period-length check, restatement
handling, concept merging) live in `scripts/fetch-data.js`. A server that
reimplements them will drift, and the drift lands precisely on the subtle cases
those rules exist to handle. Factor them into a shared module *before* writing
any server code.

---

## Project structure

No build step, no dependencies, no `package.json`. The site is plain ES modules
served as static files; the refresh script uses only the Node standard library.

```
10k-explorer/
├── index.html
├── AGENTS.md                 # Conventions and invariants for contributors
├── css/
│   └── styles.css
├── js/
│   ├── app.js        # State, event wiring, single render() entry point
│   ├── config.js     # Metric definitions, industry groups, constants
│   ├── edgar.js      # Data loading (static files + in-memory cache)
│   └── ui.js         # All DOM rendering (comparison + history tables)
├── data/
│   ├── companies.json        # Ticker → CIK/name index (10,376 tickers)
│   ├── fetch-state.json      # Per-company: last checked, has GAAP data
│   ├── manifest.json         # Timestamp and scope of the last refresh
│   └── metrics/              # One file per ticker (6,803 files, ~12 MB)
│       ├── AAPL.json
│       ├── MSFT.json
│       └── ...
├── scripts/
│   └── fetch-data.js         # Fetches/refreshes EDGAR data
└── .github/workflows/
    └── refresh-data.yml      # Monthly automated refresh
```

**Requires Node 18+** for the refresh script (native `fetch` and
`AbortSignal.timeout`). CI pins Node 20.

To preview locally, serve the directory over HTTP — opening `index.html` as a
`file://` URL will not work, because ES modules and `fetch` both require a real
origin:

```bash
python3 -m http.server 8000
```
