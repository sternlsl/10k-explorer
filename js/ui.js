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

  // Build raw value map per company (for derived metric computation)
  const companyData = companies.map((c) => {
    const raw = {};
    METRICS.forEach((m) => {
      raw[m.id] = c.metrics?.[m.id]?.value ?? null;
    });
    const derived = {};
    DERIVED_METRICS.forEach((m) => {
      derived[m.id] = m.compute(raw);
    });
    return { ...c, raw, derived };
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
          return `<td class="${cls}">${formatValue(val, metric.format)}</td>`;
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
