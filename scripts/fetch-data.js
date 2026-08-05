/**
 * fetch-data.js
 *
 * Fetches key GAAP metrics from SEC EDGAR and writes them to
 * data/metrics/{ticker}.json.
 *
 *   node scripts/fetch-data.js                 # curated default list
 *   node scripts/fetch-data.js AAPL MSFT       # specific tickers
 *   node scripts/fetch-data.js --all           # every filer in companies.json
 *   node scripts/fetch-data.js --all --force   # ignore freshness, refetch all
 *   node scripts/fetch-data.js --all --years=10  # keep 10 years, not 5
 *   node scripts/fetch-data.js --all --max-age=7 # refetch anything older than 7d
 *
 * Requires Node 18+ (native fetch, AbortSignal.timeout).
 *
 * Uses the EDGAR `companyfacts` endpoint, which returns every concept a company
 * has ever reported in a single request — including every year, so storing
 * history costs no extra requests. A full pass over ~8,000 filers takes about
 * 17 minutes at the self-imposed 8 req/sec limit.
 *
 * Each record keeps the latest year with full provenance under `metrics`, plus a
 * compact year -> value series under `history`. Files are only rewritten when
 * those numbers actually change, so a refresh that finds no new filings produces
 * an empty git diff.
 *
 * See AGENTS.md for the invariants behind the figure-selection rules; several
 * exist to prevent specific, quiet failures.
 */

const fs   = require('fs');
const path = require('path');

const USER_AGENT  = 'NYUSternLSL ilabed@stern.nyu.edu';
const API_BASE    = 'https://data.sec.gov';
const OUT_DIR     = path.join(__dirname, '..', 'data', 'metrics');
const CIK_MAP     = path.join(__dirname, '..', 'data', 'companies.json');
const FETCH_STATE = path.join(__dirname, '..', 'data', 'fetch-state.json');
const MANIFEST    = path.join(__dirname, '..', 'data', 'manifest.json');

// SEC asks for no more than 10 requests/second. We run below that.
const REQS_PER_SEC = 8;
const CONCURRENCY  = 6;
const MAX_RETRIES  = 3;
const TIMEOUT_MS   = 60_000;

// Refetch a company we last checked more than this many days ago (--force
// overrides). Tracked in data/fetch-state.json rather than in the per-company
// files, so that recording a check does not rewrite 8,000 metric files.
const DEFAULT_MAX_AGE_DAYS = 25;
// Companies with no us-gaap facts (ETFs, trusts, foreign IFRS filers) are
// recorded and skipped for this long before we look again.
const NO_GAAP_RECHECK_DAYS = 180;
// Fiscal years of history to keep per company (--years=N overrides). The
// companyfacts document already contains every year a company has reported, so
// raising this costs no extra requests — only file size.
const DEFAULT_HISTORY_YEARS = 5;

// ─── Metrics to extract ───────────────────────────────────────────────────────
// Concepts are tried in order; the first one with an annual value wins.
// `unit` picks which unit series to read and defaults to USD — per-share
// figures are reported under 'USD/shares'.
const METRICS = [
  { id: 'revenue',            concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  { id: 'cogs',               concepts: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'] },
  { id: 'grossProfit',        concepts: ['GrossProfit'] },
  { id: 'operatingIncome',    concepts: ['OperatingIncomeLoss'] },
  { id: 'netIncome',          concepts: ['NetIncomeLoss'] },
  // Basic and diluted are kept as separate metrics rather than falling back to
  // one another: a company that reports only basic EPS must not have it
  // displayed as diluted, and the spread between the two is itself worth
  // seeing when a company has significant dilution.
  { id: 'epsBasic',           concepts: ['EarningsPerShareBasic'],   unit: 'USD/shares' },
  { id: 'epsDiluted',         concepts: ['EarningsPerShareDiluted'], unit: 'USD/shares' },
  { id: 'currentAssets',      concepts: ['AssetsCurrent'] },
  { id: 'totalAssets',        concepts: ['Assets'] },
  { id: 'currentLiabilities', concepts: ['LiabilitiesCurrent'] },
  { id: 'totalLiabilities',   concepts: ['Liabilities'] },
  { id: 'shareholdersEquity', concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { id: 'operatingCashFlow',  concepts: ['NetCashProvidedByUsedInOperatingActivities'] },
  { id: 'capex',              concepts: ['PaymentsToAcquirePropertyPlantAndEquipment'] },
];

// ─── Default company list ─────────────────────────────────────────────────────
const DEFAULT_TICKERS = [
  // Industry groups (always included)
  'KO','PEP',
  'DAL','UAL','AAL','LUV',
  'AAPL','MSFT','GOOGL','META',
  'WMT','TGT','COST',
  'F','GM','TSLA',
  'JNJ','PFE','MRK',
  'JPM','BAC','WFC',
  'NFLX','DIS','WBD',
  // Additional major companies
  'AMZN','NVDA','ORCL','INTC','AMD','CSCO','IBM','QCOM','TXN','AVGO',
  'GS','MS','C','USB','AXP',
  'XOM','CVX','COP','SLB','BP',
  'UNH','CVS','CI','HUM','ANTM',
  'HD','LOW','NKE','SBUX','MCD','YUM',
  'BA','RTX','LMT','GD','NOC',
  'GE','MMM','HON','CAT','DE',
  'ABBV','AMGN','GILD','BMY','LLY',
  'T','VZ','TMUS','CMCSA','CHTR',
  'V','MA','PYPL','SQ',
  'BRK-B','CB','TRV',
  'NEE','DUK','SO','D',
  'PLD','AMT','CCI','EQIX',
  'SPG','O',
  'UBER','LYFT','ABNB','BKNG',
  'ZM','SNOW','CRM','ADBE','NOW','WDAY','TEAM',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Rate limiter ─────────────────────────────────────────────────────────────
// Hands out start slots so that concurrent workers still respect one global
// request rate. Each caller reserves the next free slot and waits for it.
const MIN_GAP = Math.ceil(1000 / REQS_PER_SEC);
let nextSlot = 0;

async function rateLimit() {
  const now  = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot   = slot + MIN_GAP;
  if (slot > now) await sleep(slot - now);
}

// ─── EDGAR fetch ──────────────────────────────────────────────────────────────
/**
 * Returns parsed JSON, or null if the company has no companyfacts document
 * (404 — common for funds and shells). Throws on persistent transport or
 * server errors so the caller can count it as a failure rather than silently
 * writing an empty record.
 */
async function edgarGet(url) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await rateLimit();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 404) return null;
      if (res.ok) return await res.json();

      // 429/5xx are worth retrying; other 4xx are not.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }

    if (attempt < MAX_RETRIES) await sleep(1000 * 2 ** (attempt - 1));
  }

  throw lastErr ?? new Error('request failed');
}

// ─── Extraction ───────────────────────────────────────────────────────────────
function padCik(cik) {
  return String(cik).padStart(10, '0');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * True if a fact covers a full fiscal year.
 *
 * Duration concepts (revenue, net income) carry `start` and `end`; a 10-K also
 * contains quarterly and multi-year durations, so we require a span of roughly
 * one year. Instant concepts (total assets) have no `start` and always qualify.
 */
function isAnnualPeriod(entry) {
  if (!entry.start) return true;
  const days = (Date.parse(entry.end) - Date.parse(entry.start)) / DAY_MS;
  return days >= 300 && days <= 400;
}

/**
 * Collapses one concept's facts into at most one figure per fiscal year.
 *
 * Within a fiscal year, later period ends win, then later filing dates: the
 * same period is re-reported as a comparative in subsequent 10-Ks, and the
 * newest filing carries any restatement.
 *
 * The fiscal year is derived from the period end date, not the `fy` field —
 * `fy` identifies the filing that reported the number, so a FY2023 comparative
 * appearing in the FY2025 10-K carries `fy: 2025`.
 */
function conceptSeries(units, unit = 'USD') {
  const entries = units?.[unit];
  if (!entries) return new Map();

  const byYear = new Map();
  for (const e of entries) {
    if (e.form !== '10-K' || e.fp !== 'FY' || !isAnnualPeriod(e)) continue;

    const year = Number(e.end.slice(0, 4));
    const prev = byYear.get(year);
    const newer = !prev
      || e.end > prev.periodEnd
      || (e.end === prev.periodEnd && (e.filed ?? '') > (prev.filed ?? ''));

    if (newer) {
      byYear.set(year, {
        value:     e.val,
        year,
        periodEnd: e.end,
        filed:     e.filed ?? null,
      });
    }
  }
  return byYear;
}

/**
 * Builds a metric's annual series, newest year first.
 *
 * Candidate concepts are merged rather than taking the first that matches at
 * all. Companies switch concepts over time — most visibly at the ASC 606
 * revenue transition — so a single company's history can span two of them. The
 * earlier-listed concept wins any year both report, keeping the priority order
 * meaningful while still filling years the preferred concept never covered.
 */
function metricSeries(gaap, metric) {
  const merged = new Map();

  for (const concept of metric.concepts) {
    for (const [year, point] of conceptSeries(gaap[concept]?.units, metric.unit)) {
      if (!merged.has(year)) merged.set(year, point);
    }
  }

  return [...merged.values()].sort((a, b) => b.year - a.year);
}

/**
 * Produces the stored record's financial content.
 *
 * `metrics` holds the latest year with full provenance and keeps the shape the
 * comparison table already consumes. `history` is a compact year → value map
 * per metric, including that latest year so each series stands alone.
 */
function extractMetrics(facts, historyYears) {
  const gaap = facts?.['us-gaap'];
  if (!gaap) return null;

  const metrics = {};
  const series  = {};
  let fiscalYear = null;

  for (const metric of METRICS) {
    const points = metricSeries(gaap, metric);
    // Latest year, derived from the same series so the two never disagree.
    metrics[metric.id] = points[0] ?? null;
    series[metric.id]  = points;

    if (points[0] && (fiscalYear === null || points[0].year > fiscalYear)) {
      fiscalYear = points[0].year;
    }
  }

  if (!Object.values(metrics).some(Boolean)) return null;

  // Keep the N most recent fiscal years the company reported anything for.
  // Companies stop and start tagging individual metrics, so the year axis is
  // the union across metrics rather than any single metric's coverage.
  //
  // Ordered oldest first, matching how JS iterates the integer-like keys of
  // `history` — both read left to right as a timeline.
  const fiscalYears = [...new Set(Object.values(series).flat().map(p => p.year))]
    .sort((a, b) => b - a)
    .slice(0, historyYears)
    .reverse();

  const history = {};
  for (const metric of METRICS) {
    const byYear = new Map(series[metric.id].map(p => [p.year, p.value]));
    history[metric.id] = Object.fromEntries(
      fiscalYears.map(y => [y, byYear.has(y) ? byYear.get(y) : null])
    );
  }

  return { metrics, history, fiscalYear, fiscalYears };
}

// ─── Write-if-changed ─────────────────────────────────────────────────────────
/** Drops timestamp fields so two records compare on financial content alone. */
function contentOnly(record) {
  const { updatedAt, fetchedAt, ...rest } = record;
  return rest;
}

/**
 * Writes only when the financial content differs from what is on disk, so a
 * refresh that finds no new filings produces an empty git diff. `updatedAt`
 * therefore means "when these numbers last changed", not "when we last looked"
 * — that is tracked separately in data/fetch-state.json.
 */
function writeIfChanged(outFile, record) {
  if (fs.existsSync(outFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      // `fetchedAt` marks a file written by the pre-companyfacts script; rewrite
      // it once so the whole corpus uses `updatedAt`.
      const migrated = 'updatedAt' in existing;
      if (migrated &&
          JSON.stringify(contentOnly(existing)) === JSON.stringify(contentOnly(record))) {
        return false;
      }
    } catch {
      // Unreadable or malformed — fall through and overwrite.
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  return true;
}

/**
 * True if the stored record exists and carries everything the current script
 * writes. Missing, unreadable, or older-shaped files all report false so the
 * company gets refetched.
 */
function isCurrentShape(outFile) {
  try {
    const record = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    return Boolean(record.history) && Array.isArray(record.fiscalYears);
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// ─── Worker pool ──────────────────────────────────────────────────────────────
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const flags   = args.filter(a => a.startsWith('--'));
  const tickerArgs = args.filter(a => !a.startsWith('--')).map(t => t.toUpperCase());

  const force  = flags.includes('--force');
  const all    = flags.includes('--all');
  const maxAge = Number(
    flags.find(f => f.startsWith('--max-age='))?.split('=')[1] ?? DEFAULT_MAX_AGE_DAYS
  ) * DAY_MS;
  const historyYears = Number(
    flags.find(f => f.startsWith('--years='))?.split('=')[1] ?? DEFAULT_HISTORY_YEARS
  );
  if (!Number.isInteger(historyYears) || historyYears < 1) {
    throw new Error(`--years must be a positive integer, got "${historyYears}"`);
  }

  const companies = readJson(CIK_MAP, null);
  if (!companies) throw new Error(`Cannot read ${CIK_MAP}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // { cik: { checked: 'YYYY-MM-DD', gaap: boolean } } — when we last looked at
  // each company and whether it reports us-gaap facts at all.
  const state = readJson(FETCH_STATE, {});
  const today = new Date().toISOString().slice(0, 10);

  const tickers = tickerArgs.length ? tickerArgs
                : all               ? Object.keys(companies)
                :                     DEFAULT_TICKERS;

  // Several tickers can share a CIK (share classes, e.g. GOOG/GOOGL), and one
  // companyfacts document serves all of them. Group so we fetch each CIK once.
  const byCik = new Map();
  const unknown = [];

  for (const ticker of tickers) {
    const company = companies[ticker];
    if (!company) { unknown.push(ticker); continue; }
    if (!byCik.has(company.cik)) byCik.set(company.cik, []);
    byCik.get(company.cik).push({ ticker, name: company.name });
  }

  const targets = [...byCik.entries()].map(([cik, tickers]) => ({ cik, tickers }));
  const verbose = targets.length <= 100;

  console.log(
    `Fetching ${targets.length} companies (${tickers.length} tickers)` +
    `${force ? ', forced' : `, refetching older than ${maxAge / DAY_MS}d`}...\n`
  );

  const stats = { written: 0, unchanged: 0, fresh: 0, noData: 0, failed: 0 };
  const failures = [];
  let done = 0;

  await pool(targets, CONCURRENCY, async ({ cik, tickers }) => {
    const label = tickers.map(t => t.ticker).join('/');
    done++;

    if (!verbose && done % 100 === 0) {
      console.log(`  ...${done}/${targets.length}`);
    }

    const seen = state[cik];
    const age  = seen ? Date.now() - Date.parse(seen.checked) : Infinity;
    // A file that predates a change to the record shape has to be rebuilt even
    // when the freshness check would otherwise skip it — otherwise a scheduled
    // run right after such a change skips every company and rolls out nothing.
    const missing = tickers.some(t => !isCurrentShape(path.join(OUT_DIR, `${t.ticker}.json`)));

    if (!force && seen) {
      // Companies that report no us-gaap facts rarely start doing so; check
      // them back rarely.
      if (seen.gaap === false && age < NO_GAAP_RECHECK_DAYS * DAY_MS) {
        stats.noData++;
        if (verbose) console.log(`  [NO-GAAP] ${label} (cached)`);
        return;
      }
      // Recently checked and every ticker already has a file on disk.
      if (seen.gaap !== false && age < maxAge && !missing) {
        stats.fresh++;
        if (verbose) console.log(`  [FRESH] ${label}`);
        return;
      }
    }

    let facts;
    try {
      facts = await edgarGet(`${API_BASE}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`);
    } catch (err) {
      stats.failed++;
      failures.push(`${label}: ${err.message}`);
      console.error(`  [ERROR] ${label} — ${err.message}`);
      return;
    }

    const extracted = facts && extractMetrics(facts.facts, historyYears);
    if (!extracted) {
      state[cik] = { checked: today, gaap: false };
      stats.noData++;
      if (verbose) console.log(`  [NO-GAAP] ${label}`);
      return;
    }

    state[cik] = { checked: today, gaap: true };
    const updatedAt = new Date().toISOString();
    let changed = false;

    for (const { ticker, name } of tickers) {
      const record = {
        ticker, name, cik,
        fiscalYear:  extracted.fiscalYear,
        fiscalYears: extracted.fiscalYears,
        metrics:     extracted.metrics,
        history:     extracted.history,
        updatedAt,
      };
      if (writeIfChanged(path.join(OUT_DIR, `${ticker}.json`), record)) changed = true;
    }

    if (changed) stats.written++; else stats.unchanged++;
    if (verbose) {
      console.log(`  [${changed ? 'UPDATED' : 'SAME'}] ${label} — FY${extracted.fiscalYear ?? '?'}`);
    }
  });

  // Sorted so the file has a stable key order and a readable diff.
  const sortedState = Object.fromEntries(
    Object.keys(state).sort((a, b) => Number(a) - Number(b)).map(k => [k, state[k]])
  );
  fs.writeFileSync(FETCH_STATE, JSON.stringify(sortedState, null, 2) + '\n');

  fs.writeFileSync(MANIFEST, JSON.stringify({
    refreshedAt: new Date().toISOString(),
    companies: fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json')).length,
    scope: tickerArgs.length ? 'tickers' : all ? 'all' : 'default',
  }, null, 2) + '\n');

  if (unknown.length) {
    console.warn(`\n${unknown.length} ticker(s) not in company index: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? '…' : ''}`);
  }

  console.log(
    `\nDone. ${stats.written} updated, ${stats.unchanged} unchanged, ` +
    `${stats.fresh} still fresh, ${stats.noData} no GAAP data, ${stats.failed} failed.`
  );

  if (failures.length) {
    console.error(`\nFailures:\n${failures.slice(0, 20).map(f => `  ${f}`).join('\n')}`);
    // A handful of transient failures shouldn't fail a scheduled refresh; a
    // widespread outage should.
    if (failures.length > Math.max(10, targets.length * 0.05)) {
      throw new Error(`${failures.length} companies failed — aborting.`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
