import { CACHE_TTL } from './config.js';

// data/companies.json — bundled ticker→{cik,name} index (no CORS issues, same origin)
const COMPANIES_URL = './data/companies.json';

// data/available.json — the subset of those tickers we hold metrics for
const AVAILABLE_URL = './data/available.json';

// data/metrics/{ticker}.json — pre-fetched GAAP metrics per company
const METRICS_URL = (ticker) => `./data/metrics/${ticker}.json`;

// In-memory ticker index: { TICKER: { cik, name } }
let tickersIndex = null;

// Tickers with a metrics file, or null when the availability list could not be
// loaded — see hasMetrics().
let availableTickers = null;

// ─── Ticker index ─────────────────────────────────────────────────────────────

export async function loadTickersIndex() {
  if (tickersIndex) return;
  const res = await fetch(COMPANIES_URL);
  if (!res.ok) throw new Error('Failed to load company index.');
  tickersIndex = await res.json();

  // companies.json covers every SEC filer, but about a third of them — foreign
  // IFRS filers, funds, trusts, shells — report no us-gaap facts and have no
  // metrics file. Loading the available set lets search offer only companies
  // that will actually open.
  try {
    const availableRes = await fetch(AVAILABLE_URL);
    if (availableRes.ok) availableTickers = new Set(await availableRes.json());
  } catch {
    // Left null below: an unusable availability list must not empty out search.
  }
}

/**
 * Whether we hold metrics for a ticker. If the availability list is missing —
 * an older deployment, a failed request — every ticker reports true and the
 * metrics fetch itself is left to decide, as it did before the list existed.
 */
export function hasMetrics(ticker) {
  return !availableTickers || availableTickers.has(ticker.toUpperCase());
}

export function lookupTicker(ticker) {
  return tickersIndex?.[ticker.toUpperCase()] ?? null;
}

export function searchCompanies(query) {
  if (!tickersIndex || query.length < 2) return [];
  const q = query.toLowerCase();
  return Object.entries(tickersIndex)
    .filter(
      ([ticker, c]) =>
        hasMetrics(ticker) &&
        (ticker.toLowerCase().startsWith(q) ||
          c.name.toLowerCase().includes(q))
    )
    .map(([ticker, c]) => ({ ticker, ...c }))
    .slice(0, 20);
}

// ─── Metrics loading ──────────────────────────────────────────────────────────

// Simple in-memory cache to avoid re-fetching within a session
const metricsCache = {};

export async function getCompanyMetrics(ticker) {
  ticker = ticker.toUpperCase();

  if (metricsCache[ticker]) return metricsCache[ticker];

  const company = lookupTicker(ticker);
  if (!company) throw new Error(`Ticker not found: ${ticker}`);

  const res = await fetch(METRICS_URL(ticker));
  if (!res.ok) {
    throw new Error(
      `No data available for ${ticker}. It may not be in our pre-loaded dataset yet.`
    );
  }

  const data = await res.json();
  metricsCache[ticker] = data;
  return data;
}
