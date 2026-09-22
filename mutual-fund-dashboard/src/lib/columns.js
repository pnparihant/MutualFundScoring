import { DASH, formatCrore, formatNumber, formatPercent } from './format'

/**
 * Presentation glue between a scored parameter and the raw value it was scored
 * from.
 *
 * Labels, groups and weights all come from the API (`/api/funds` -> `columns`),
 * derived there from the scoring model's own PARAM_LABELS / PARAM_CATEGORY /
 * WEIGHTS, so they can't drift. What lives here is only the display decision of
 * which raw metric to show beneath which score, and how to format it -- the
 * `metrics` keys are the column headers of the dataset workbook.
 */
export const PARAM_METRICS = {
  rolling_returns_3y: { keys: ['Rolling Returns 3Y (%)'], format: 'percent' },
  rolling_returns_5y: { keys: ['Rolling Returns 5Y (%)'], format: 'percent' },
  alpha_3y: { keys: ['Alpha (3Y)'], format: 'number' },
  cagr_vs_category_avg: { keys: ['CAGR vs Category Avg 5Y (%)'], format: 'percent' },
  sd_vs_category: { keys: ['Standard Deviation (vs Category)'], format: 'number' },
  sharpe_3y: { keys: ['Sharpe Ratio (3Y)'], format: 'number' },
  sortino_3y: { keys: ['Sortino Ratio (3Y)'], format: 'number' },
  beta: { keys: ['Beta'], format: 'number' },
  exit_load_structure: { keys: ['Exit Load Structure'], format: 'text' },
  aum_size_category_adjusted: { keys: ['AUM Size (Cr)'], format: 'crore' },
  portfolio_concentration: { keys: ['Top 10 Holdings (%)'], format: 'percent' },
  sector_diversification: { keys: ['Sector Count (>=5% each)'], format: 'number' },
  expense_ratio_vs_category: { keys: ['Expense Ratio (%)'], format: 'percent' },
  amc_reputation: { keys: ['AMC Reputation Tier (1/3/5)'], format: 'number' },
}

/** Metric keys that identify a fund rather than measure it. */
export const IDENTITY_METRIC_KEYS = ['Fund Manager', 'Benchmark Name']

export function formatMetricValue(value, format) {
  switch (format) {
    case 'percent':
      return formatPercent(value)
    case 'crore':
      return formatCrore(value)
    case 'text':
      return value || DASH
    default:
      return formatNumber(value)
  }
}

/**
 * The raw value(s) behind a parameter, formatted for a table cell. Rolling
 * returns has two source columns (3Y and 5Y) and shows both.
 */
export function metricSummary(row, paramKey) {
  const spec = PARAM_METRICS[paramKey]
  if (!spec) return DASH
  const metrics = row.metrics ?? {}
  const parts = spec.keys.map((key) => formatMetricValue(metrics[key], spec.format))
  if (spec.format === 'text') return parts[0]
  return parts.join(spec.joiner ?? ' ')
}

/** The single numeric value a parameter column should sort by. */
export function metricSortValue(row, paramKey) {
  const spec = PARAM_METRICS[paramKey]
  if (!spec) return null
  const raw = row.metrics?.[spec.keys[0]]
  if (spec.format === 'text') return raw ?? ''
  return raw ?? null
}

/** Score 1..5 -> the token set used for badges and cell tinting. */
export function scoreTone(score) {
  if (score === null || score === undefined) return 0
  return Math.max(1, Math.min(5, Math.round(Number(score))))
}

/**
 * Rating -> tone. Keyed by name rather than by rounding the composite, so the
 * colour always agrees with the matrix's own band boundaries (a 3.49 is "Average"
 * and must not be tinted like a 4).
 */
export const RATING_TONES = {
  Outstanding: 5,
  Excellent: 5,
  Good: 4,
  Average: 3,
  'Below Average': 2,
  Poor: 1,
  'Insufficient Data': 0,
}

export const RECOMMENDATION_TONES = {
  'Strong Buy': 5,
  Buy: 5,
  'Buy / Watch': 4,
  'Hold / Consider': 3,
  Avoid: 2,
  Reject: 1,
  'N/A': 0,
}
