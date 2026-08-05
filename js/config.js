export const METRICS = [
  // Income Statement
  {
    id: 'revenue',
    label: 'Revenue',
    section: 'Income Statement',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
    ],
    format: 'currency',
  },
  {
    id: 'cogs',
    label: 'Cost of Goods Sold',
    section: 'Income Statement',
    concepts: [
      'CostOfGoodsAndServicesSold',
      'CostOfRevenue',
      'CostOfGoodsSold',
    ],
    format: 'currency',
  },
  {
    id: 'grossProfit',
    label: 'Gross Profit',
    section: 'Income Statement',
    concepts: ['GrossProfit'],
    format: 'currency',
  },
  {
    id: 'operatingIncome',
    label: 'Operating Income',
    section: 'Income Statement',
    concepts: ['OperatingIncomeLoss'],
    format: 'currency',
  },
  {
    id: 'netIncome',
    label: 'Net Income',
    section: 'Income Statement',
    concepts: ['NetIncomeLoss'],
    format: 'currency',
  },
  {
    id: 'epsBasic',
    label: 'EPS (Basic)',
    section: 'Income Statement',
    concepts: ['EarningsPerShareBasic'],
    format: 'perShare',
  },
  {
    id: 'epsDiluted',
    label: 'EPS (Diluted)',
    section: 'Income Statement',
    concepts: ['EarningsPerShareDiluted'],
    format: 'perShare',
  },
  // Balance Sheet
  {
    id: 'currentAssets',
    label: 'Current Assets',
    section: 'Balance Sheet',
    concepts: ['AssetsCurrent'],
    format: 'currency',
  },
  {
    id: 'totalAssets',
    label: 'Total Assets',
    section: 'Balance Sheet',
    concepts: ['Assets'],
    format: 'currency',
  },
  {
    id: 'currentLiabilities',
    label: 'Current Liabilities',
    section: 'Balance Sheet',
    concepts: ['LiabilitiesCurrent'],
    format: 'currency',
  },
  {
    id: 'totalLiabilities',
    label: 'Total Liabilities',
    section: 'Balance Sheet',
    concepts: ['Liabilities'],
    format: 'currency',
  },
  {
    id: 'shareholdersEquity',
    label: "Shareholders' Equity",
    section: 'Balance Sheet',
    concepts: [
      'StockholdersEquity',
      'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    ],
    format: 'currency',
  },
  // Cash Flow
  {
    id: 'operatingCashFlow',
    label: 'Operating Cash Flow',
    section: 'Cash Flow',
    concepts: ['NetCashProvidedByUsedInOperatingActivities'],
    format: 'currency',
  },
  {
    id: 'capex',
    label: 'Capital Expenditures',
    section: 'Cash Flow',
    concepts: ['PaymentsToAcquirePropertyPlantAndEquipment'],
    format: 'currency',
  },
];

// Computed from the raw metrics above — no EDGAR fetch needed
export const DERIVED_METRICS = [
  {
    id: 'freeCashFlow',
    label: 'Free Cash Flow',
    section: 'Cash Flow',
    format: 'currency',
    compute: (d) =>
      d.operatingCashFlow != null && d.capex != null
        ? d.operatingCashFlow - d.capex
        : null,
  },
  {
    id: 'grossMargin',
    label: 'Gross Margin',
    section: 'Ratios',
    format: 'percent',
    compute: (d) =>
      d.grossProfit != null && d.revenue
        ? d.grossProfit / d.revenue
        : null,
  },
  {
    id: 'netMargin',
    label: 'Net Profit Margin',
    section: 'Ratios',
    format: 'percent',
    compute: (d) =>
      d.netIncome != null && d.revenue ? d.netIncome / d.revenue : null,
  },
  {
    id: 'currentRatio',
    label: 'Current Ratio',
    section: 'Ratios',
    format: 'ratio',
    compute: (d) =>
      d.currentAssets != null && d.currentLiabilities
        ? d.currentAssets / d.currentLiabilities
        : null,
  },
  {
    id: 'debtToEquity',
    label: 'Debt-to-Equity',
    section: 'Ratios',
    format: 'ratio',
    compute: (d) =>
      d.totalLiabilities != null && d.shareholdersEquity
        ? d.totalLiabilities / d.shareholdersEquity
        : null,
  },
  {
    id: 'roe',
    label: 'Return on Equity (ROE)',
    section: 'Ratios',
    format: 'percent',
    compute: (d) =>
      d.netIncome != null && d.shareholdersEquity
        ? d.netIncome / d.shareholdersEquity
        : null,
  },
];

export const INDUSTRY_GROUPS = [
  { id: 'beverages',  label: 'Beverages',  tickers: ['KO', 'PEP'] },
  { id: 'airlines',   label: 'Airlines',   tickers: ['DAL', 'UAL', 'AAL', 'LUV'] },
  { id: 'tech',       label: 'Big Tech',   tickers: ['AAPL', 'MSFT', 'GOOGL', 'META'] },
  { id: 'retail',     label: 'Retail',     tickers: ['WMT', 'TGT', 'COST'] },
  { id: 'auto',       label: 'Auto',       tickers: ['F', 'GM', 'TSLA'] },
  { id: 'pharma',     label: 'Pharma',     tickers: ['JNJ', 'PFE', 'MRK'] },
  { id: 'banks',      label: 'Banks',      tickers: ['JPM', 'BAC', 'WFC'] },
  { id: 'streaming',  label: 'Streaming',  tickers: ['NFLX', 'DIS', 'WBD'] },
];

export const MAX_COMPANIES = 4;
export const DEFAULT_GROUP = 'beverages';

// 24 hours in ms
export const CACHE_TTL = 24 * 60 * 60 * 1000;
