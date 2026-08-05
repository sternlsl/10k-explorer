import { METRICS, DERIVED_METRICS, INDUSTRY_GROUPS, MAX_COMPANIES } from './config.js';

// Section display order
const SECTION_ORDER = ['Income Statement', 'Balance Sheet', 'Cash Flow', 'Ratios'];

// --- Value formatting ---

function formatCurrency(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toLocaleString()}`;
}

function formatValue(value, format) {
  if (value === null || value === undefined) {
    return '<span class="na">N/A</span>';
  }
  switch (format) {
    case 'currency': return formatCurrency(value);
    // Per-share figures stay in dollars and cents rather than being abbreviated.
    case 'perShare': return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
    case 'percent':  return `${(value * 100).toFixed(1)}%`;
    case 'ratio':    return `${value.toFixed(2)}x`;
    default:         return String(value);
  }
}

function valueClass(value, format) {
  if (value === null || value === undefined) return '';
  if (format === 'currency' || format === 'percent' || format === 'perShare') {
    return value < 0 ? 'negative' : '';
  }
  return '';
}

// --- Industry shortcuts ---

export function renderIndustryShortcuts(activeGroupId, onSelect) {
  const container = document.getElementById('industry-shortcuts');
  container.innerHTML = INDUSTRY_GROUPS.map((g) =>
    `<button class="shortcut-btn${g.id === activeGroupId ? ' active' : ''}" data-group="${g.id}">
      ${g.label}
    </button>`
  ).join('');

  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-group]');
    if (btn) onSelect(btn.dataset.group);
  });
}

export function setActiveShortcut(groupId) {
  document.querySelectorAll('.shortcut-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.group === groupId);
  });
}

// --- Company chips ---

export function renderCompanyChips(companies, onRemove) {
  const container = document.getElementById('company-chips');
  const addBtn = document.getElementById('search-container');

  if (!companies.length) {
    container.innerHTML = '<p class="no-companies">No companies selected. Use the shortcuts or search above.</p>';
    addBtn.hidden = false;
    return;
  }

  container.innerHTML = companies.map((c) =>
    `<div class="chip${c.loading ? ' chip--loading' : ''}" data-ticker="${c.ticker}">
      <span class="chip-ticker">${c.ticker}</span>
      <span class="chip-name">${c.name}</span>
      ${c.loading
        ? '<span class="chip-spinner"></span>'
        : `<button class="chip-remove" data-ticker="${c.ticker}" aria-label="Remove ${c.ticker}">×</button>`
      }
    </div>`
  ).join('');

  // Show/hide search input based on company count
  addBtn.hidden = companies.length >= MAX_COMPANIES;

  container.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(btn.dataset.ticker));
  });
}

// --- Comparison table ---

export function renderTable(companies) {
  const container = document.getElementById('metrics-table');

  if (!companies.length) {
    container.innerHTML = '<p class="empty-state">Add companies above to start comparing.</p>';
    return;
  }

  const companyData = companies.map((c) => {
    const raw = {};      // as reported, whatever year it came from
    const year = {};     // the year each figure actually covers
    const current = {};  // only figures from this company's latest fiscal year

    METRICS.forEach((m) => {
      const point = c.metrics?.[m.id] ?? null;
      raw[m.id]   = point?.value ?? null;
      year[m.id]  = point?.year ?? null;
      // Companies stop tagging concepts without ever resuming, leaving a last
      // reported figure that can be many years old. Ratios must not mix those
      // with current-year figures — free cash flow off a 2009 capex and a 2025
      // operating cash flow is not a number worth showing.
      current[m.id] = point && point.year === c.fiscalYear ? point.value : null;
    });

    const derived = {};
    DERIVED_METRICS.forEach((m) => {
      derived[m.id] = m.compute(current);
    });
    return { ...c, raw, year, derived };
  });

  const allMetrics = [...METRICS, ...DERIVED_METRICS];
  const colCount = companies.length + 1;

  // Flag companies with 4+ null raw metrics — typically financials, REITs, insurers
  const NULL_THRESHOLD = 4;
  const flagged = companyData.map((cd) => {
    const nullCount = METRICS.filter((m) => cd.raw[m.id] === null).length;
    return !cd.loading && nullCount >= NULL_THRESHOLD;
  });
  const anyFlagged = flagged.some(Boolean);

  let html = `<div class="table-wrapper"><table>
    <thead>
      <tr>
        <th class="metric-col">Metric</th>
        ${companyData.map((cd, i) =>
          `<th>
            <div class="th-company">${cd.name}${flagged[i] ? ' <span class="flag-marker" title="Specialized reporting format">†</span>' : ''}</div>
            <div class="th-ticker">${cd.ticker}${cd.fiscalYear ? ` &middot; FY${cd.fiscalYear}` : ''}</div>
          </th>`
        ).join('')}
      </tr>
    </thead>
    <tbody>`;

  SECTION_ORDER.forEach((section) => {
    const sectionMetrics = allMetrics.filter((m) => m.section === section);
    if (!sectionMetrics.length) return;

    html += `<tr class="section-row"><td colspan="${colCount}">${section}</td></tr>`;

    sectionMetrics.forEach((metric) => {
      html += `<tr>
        <td class="metric-label">${metric.label}</td>
        ${companyData.map((cd) => {
          const val = metric.compute
            ? cd.derived[metric.id]
            : cd.raw[metric.id];
          const cls = valueClass(val, metric.format);
          const loading = cd.loading && val === null;
          if (loading) return `<td><span class="cell-loading"></span></td>`;

          // Flag a figure the company last reported in an earlier year, so it
          // is not read as belonging to the fiscal year in the column header.
          const y = cd.year?.[metric.id];
          const stale = !metric.compute && y != null && y !== cd.fiscalYear
            ? ` <span class="stale-year" title="Last reported for FY${y}">FY${y}</span>`
            : '';
          return `<td class="${cls}">${formatValue(val, metric.format)}${stale}</td>`;
        }).join('')}
      </tr>`;
    });
  });

  html += `</tbody></table>`;

  if (anyFlagged) {
    html += `<p class="reporting-note">
      <span class="flag-marker">†</span>
      This company uses a specialized reporting format (e.g. financial services, insurance, or real estate).
      Some standard metrics may not apply and will appear as N/A.
    </p>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// --- History view ---

/**
 * Renders one company's metrics with fiscal years as columns.
 *
 * Derived metrics are recomputed per year from that year's reported figures,
 * so margins and ratios trend alongside the raw values rather than being
 * pinned to the latest year.
 */
export function renderHistoryTable(company) {
  const container = document.getElementById('metrics-table');

  if (!company) {
    container.innerHTML = '<p class="empty-state">Add a company to see its history.</p>';
    return;
  }
  if (company.loading) {
    container.innerHTML = `<p class="empty-state">Loading ${company.name}…</p>`;
    return;
  }

  const years = company.fiscalYears ?? [];
  if (!years.length) {
    container.innerHTML =
      `<p class="empty-state">No multi-year history available for ${company.name}.</p>`;
    return;
  }

  const perYear = years.map((year) => {
    const raw = {};
    METRICS.forEach((m) => {
      raw[m.id] = company.history?.[m.id]?.[year] ?? null;
    });
    const derived = {};
    DERIVED_METRICS.forEach((m) => {
      derived[m.id] = m.compute(raw);
    });
    return { year, raw, derived };
  });

  const allMetrics = [...METRICS, ...DERIVED_METRICS];

  let html = `<div class="table-wrapper"><table>
    <thead>
      <tr>
        <th class="metric-col">Metric</th>
        ${perYear.map((y) => `<th><div class="th-ticker">FY${y.year}</div></th>`).join('')}
      </tr>
    </thead>
    <tbody>`;

  SECTION_ORDER.forEach((section) => {
    const sectionMetrics = allMetrics.filter((m) => m.section === section);
    if (!sectionMetrics.length) return;

    html += `<tr class="section-row"><td colspan="${perYear.length + 1}">${section}</td></tr>`;

    sectionMetrics.forEach((metric) => {
      html += `<tr>
        <td class="metric-label">${metric.label}</td>
        ${perYear.map((y) => {
          const val = metric.compute ? y.derived[metric.id] : y.raw[metric.id];
          return `<td class="${valueClass(val, metric.format)}">${formatValue(val, metric.format)}</td>`;
        }).join('')}
      </tr>`;
    });
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

/**
 * Renders the compare/history switch, plus a company picker when several
 * companies are loaded (history shows one company at a time).
 */
export function renderViewControls(mode, companies, selectedTicker, handlers) {
  const el = document.getElementById('view-controls');

  if (!companies.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;

  const picker =
    mode === 'history' && companies.length > 1
      ? `<select id="history-company" class="history-select" aria-label="Company to show history for">
           ${companies.map((c) =>
             `<option value="${c.ticker}"${c.ticker === selectedTicker ? ' selected' : ''}>${c.name}</option>`
           ).join('')}
         </select>`
      : '';

  el.innerHTML = `
    <button class="shortcut-btn${mode === 'compare' ? ' active' : ''}" data-mode="compare">Compare companies</button>
    <button class="shortcut-btn${mode === 'history' ? ' active' : ''}" data-mode="history">5-year history</button>
    ${picker}`;

  el.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => handlers.onMode(btn.dataset.mode));
  });
  const select = el.querySelector('#history-company');
  if (select) {
    select.addEventListener('change', () => handlers.onCompany(select.value));
  }
}

// --- Search dropdown ---

export function renderSearchResults(results, onSelect) {
  const dropdown = document.getElementById('search-dropdown');
  if (!results.length) {
    dropdown.hidden = true;
    dropdown.innerHTML = '';
    return;
  }
  dropdown.innerHTML = results.map((r) =>
    `<div class="search-result" data-ticker="${r.ticker}">
      <span class="result-ticker">${r.ticker}</span>
      <span class="result-name">${r.name}</span>
    </div>`
  ).join('');
  dropdown.hidden = false;

  dropdown.querySelectorAll('.search-result').forEach((el) => {
    el.addEventListener('click', () => {
      onSelect(el.dataset.ticker);
    });
  });
}

// --- Error banner ---

let errorTimer = null;

export function showError(message) {
  const el = document.getElementById('error-banner');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// --- Loading overlay ---

export function setGlobalLoading(visible) {
  document.getElementById('loading-overlay').hidden = !visible;
}
