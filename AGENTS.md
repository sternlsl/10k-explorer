# Working in this repo

Conventions and constraints for anyone — human or agent — changing this project.
[`README.md`](README.md) covers what the app is and how to run it; this file
covers what will bite you.

## Shape of the project

A static site (plain ES modules, no framework, no build step) plus one Node
script that pre-fetches financial data from SEC EDGAR into `data/metrics/`.
There is no `package.json` and no dependencies — the script uses only the Node
standard library. **Keep it that way unless there is a strong reason not to.**
A dependency-free repo is why the refresh workflow needs no lockfile audit and
why the site cannot break at runtime.

Requires Node 18+ (native `fetch`, `AbortSignal.timeout`). CI pins Node 20.

## Invariants

Break these and things go wrong quietly rather than loudly.

**Only write a metric file when its numbers change.** `writeIfChanged` compares
records with timestamps stripped. Every file carries an `updatedAt`, and if that
were refreshed on every run, each monthly refresh would rewrite all 6,803 files
and add ~12 MB to the repo forever. This is also why "when we last looked" lives
in `data/fetch-state.json` rather than in the metric files.

**A record predating a shape change must be refetched.** `isCurrentShape` gates
the freshness check. Without it, the first scheduled run after a format change
finds every company "fresh", skips them all, and rolls out nothing. If you add a
field to the stored record, update that function in the same commit.

**Match companies on CIK, never on ticker.** One filer has many tickers — share
classes (`GOOG`/`GOOGL`), preferred shares (`PSA-PH`), bonds (`TBB` is AT&T).
All resolve to the same financials. Ticker shape cannot identify security type:
`BRKR` is Bruker's common stock, `MGR` is a bond. Do not write a regex for this.

**Never let a derived metric mix fiscal years.** `renderTable` computes ratios
from `current` (figures matching the company's headline year), not `raw`.
Roughly 40% of companies have a metric years staler than the rest of the filing;
computing free cash flow from 2025 cash flow and 2009 capex produces a
plausible-looking number that is meaningless.

**Respect the SEC rate limit globally.** 8 requests/second across the whole
process, enforced by the slot-reserving `rateLimit()`. Concurrency is 6 workers
sharing that one limiter. Running two replicas or two concurrent jobs silently
doubles the real rate.

## Figure selection

The rules in `scripts/fetch-data.js` exist because of specific failures. Do not
simplify them without understanding what each one catches:

- **`isAnnualPeriod`** — duration facts must span 300–400 days. Annual reports
  contain quarterly figures tagged `fp: FY`. Without this check Berkshire
  Hathaway displays an EPS of **$3,035** (quarterly Class A figures, last tagged
  2013).
- **Year comes from `end`, not `fy`.** The `fy` field identifies the filing that
  reported a number, not the period it covers. A FY2023 comparative restated in
  the FY2025 10-K carries `fy: 2025`.
- **Ties break on `filed`.** The same period is re-reported as a comparative in
  later filings; the newest filing carries any restatement. Sorting on period end
  alone keeps whichever came first in the array, which is the oldest filing.
- **Concepts merge per year, not first-match-wins.** Companies switch concepts
  (most visibly at the ASC 606 revenue transition). Taking the first concept with
  *any* value made Exxon report FY2021 revenue beside FY2025 figures. The
  earlier-listed concept still wins any year both cover.

If a live API path is ever added, factor these into a shared module first. Two
implementations will drift, and the drift lands exactly here.

## Verifying changes

**Always diff new output against committed data before trusting it:**

```bash
node scripts/fetch-data.js AAPL MSFT KO JPM XOM --force
git diff data/metrics/
```

An unexpected value change is the signal that matters. Companies worth including
in any spot check:

| Ticker | Why |
|---|---|
| `XOM`, `GOOGL` | Switched revenue concepts — catch first-match-wins regressions |
| `BRK-B` | EPS must be N/A, never a number |
| `SPGI`, `HST` | Capex last tagged FY2009 — stale badge and N/A free cash flow |
| `RIVN`, `F` | Negative EPS; basic should equal diluted for a loss |
| `T` + `TBB` | Same CIK — the second must be refused |

**Reset test data before committing.** Ad-hoc runs leave a partial corpus. Code
changes and data refreshes belong in separate commits; let the workflow produce
the data commit.

```bash
git checkout -- data/ && git clean -fd data/
```

## Front-end gotchas

**Browsers cache ES modules aggressively.** Editing a `.js` file and reloading
often serves the old module — a hard refresh is not always enough. Symptom: your
change appears to have no effect. Check `performance.getEntriesByType('resource')`
for `transferSize: 0`, and serve on a different port to get a clean cache key.
This will also affect the live site after a deploy.

**`renderTable` and `renderHistoryTable` share section ordering and formatters.**
Add a metric format in one place (`formatValue`, `valueClass`) and both views get
it.

**All redraws go through `render()` in `app.js`.** It picks the view mode and
keeps chips, controls, and table in sync. Do not call the render functions
directly from event handlers.

## GitHub Actions

**Scheduled and manually-dispatched workflows only run if the workflow file
exists on the default branch.** A workflow added on a feature branch is
invisible — the "Run workflow" button never appears. Dispatch does accept a
`ref`, and runs that ref's version of the file, so testing on a branch requires
the file to be present on `main` first.

The refresh job commits to `github.ref_name`, so dispatching against a branch
writes data to that branch and leaves `main` alone. A full `--all` run takes
~17 minutes and produces a large data commit; test with `scope: default` (~110
companies, ~15 seconds) before running the full pass.

GitHub Pages serves `main` at `/`, so anything merged there is live immediately.

## Known warts

- `js/edgar.js` imports `CACHE_TTL` from `config.js` but never uses it. The
  in-memory metrics cache has no expiry — it lasts one page session.
- The search dropdown lists bonds and preferred shares alongside common stock
  (see README). Ranking the shortest ticker per CIK first would improve this
  safely; filtering them out would not.
