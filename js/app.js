import { INDUSTRY_GROUPS, MAX_COMPANIES, DEFAULT_GROUP } from './config.js';
import { loadTickersIndex, lookupTicker, searchCompanies, getCompanyMetrics } from './edgar.js';
import {
  renderIndustryShortcuts,
  setActiveShortcut,
  renderCompanyChips,
  renderTable,
  renderSearchResults,
  showError,
  setGlobalLoading,
} from './ui.js';

// App state
let companies = [];       // [{ticker, name, cik, metrics, fiscalYear, loading}]
let activeGroupId = null;

// --- Company management ---

async function addCompany(ticker) {
  ticker = ticker.toUpperCase();

  const info = lookupTicker(ticker);
  if (!info) {
    showError(`"${ticker}" not found. Try searching by company name.`);
    return;
  }

  // Match on CIK rather than ticker. One filer often has several tickers —
  // share classes (GOOG/GOOGL), preferred shares (PSA-PH), baby bonds (TBB) —
  // and every one of them resolves to the same annual report, so matching on
  // ticker alone would let the same company occupy two identical columns.
  const existing = companies.find((c) => c.cik === info.cik);
  if (existing) {
    if (existing.ticker !== ticker) {
      showError(`${info.name} is already in this comparison, as ${existing.ticker}.`);
    }
    return;
  }

  if (companies.length >= MAX_COMPANIES) {
    showError(`You can compare up to ${MAX_COMPANIES} companies at a time.`);
    return;
  }

  // Insert placeholder so the table updates immediately with a loading state
  const placeholder = { ticker, name: info.name, cik: info.cik, metrics: {}, fiscalYear: null, loading: true };
  companies = [...companies, placeholder];
  renderCompanyChips(companies, removeCompany);
  renderTable(companies);

  try {
    const data = await getCompanyMetrics(ticker);
    companies = companies.map((c) => (c.ticker === ticker ? { ...data, loading: false } : c));
  } catch (err) {
    showError(`Failed to load data for ${ticker}. ${err.message}`);
    companies = companies.filter((c) => c.ticker !== ticker);
  }

  renderCompanyChips(companies, removeCompany);
  renderTable(companies);
}

function removeCompany(ticker) {
  companies = companies.filter((c) => c.ticker !== ticker);
  // If the user manually removes a company, deactivate the industry shortcut
  activeGroupId = null;
  setActiveShortcut(null);
  renderCompanyChips(companies, removeCompany);
  renderTable(companies);
}

// --- Industry group loading ---

async function loadGroup(groupId) {
  const group = INDUSTRY_GROUPS.find((g) => g.id === groupId);
  if (!group) return;

  activeGroupId = groupId;
  companies = [];
  setActiveShortcut(groupId);
  renderCompanyChips(companies, removeCompany);
  renderTable(companies);

  // Load first 2 companies as the default comparison; users can add more
  const defaultTickers = group.tickers.slice(0, 2);
  await Promise.all(defaultTickers.map((t) => addCompany(t)));
}

// --- Search ---

function setupSearch() {
  const input = document.getElementById('search-input');
  const dropdown = document.getElementById('search-dropdown');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q.length < 2) {
      dropdown.hidden = true;
      return;
    }
    renderSearchResults(searchCompanies(q), (ticker) => {
      input.value = '';
      dropdown.hidden = true;
      activeGroupId = null;
      setActiveShortcut(null);
      addCompany(ticker);
    });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      dropdown.hidden = true;
    }
  });

  // Close dropdown when clicking outside the search box
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-container')) {
      dropdown.hidden = true;
    }
  });
}

// --- Init ---

async function init() {
  setGlobalLoading(true);

  try {
    await loadTickersIndex();
  } catch {
    showError('Could not load the company index from SEC. Please check your connection and refresh.');
    setGlobalLoading(false);
    return;
  }

  setGlobalLoading(false);

  renderIndustryShortcuts(DEFAULT_GROUP, loadGroup);
  setupSearch();

  await loadGroup(DEFAULT_GROUP);
}

init();
