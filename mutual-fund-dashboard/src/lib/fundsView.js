import { PARAM_METRICS, metricSortValue } from './columns'
import { formatCompleteness, formatNumber } from './format'

export const FUND_INFO_GROUP = 'Fund Info'

/* ------------------------------- searching ------------------------------- */

/**
 * Cached lowercase haystack per row. Rebuilding it for 1,383 rows on every
 * keystroke is the one thing here expensive enough to matter, and the row
 * objects are replaced wholesale on refresh, so a WeakMap keyed on the row is
 * both safe and self-clearing.
 */
const searchIndex = new WeakMap()

function haystack(row) {
  let cached = searchIndex.get(row)
  if (cached === undefined) {
    cached = [
      row.fund,
      row.category,
      row.rating,
      row.recommendation,
      String(row.schcode ?? ''),
      row.metrics?.['Fund Manager'],
      row.metrics?.['Benchmark Name'],
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    searchIndex.set(row, cached)
  }
  return cached
}

/* ------------------------------- filtering ------------------------------- */

export const EMPTY_FILTERS = {
  query: '',
  categories: [],
  ratings: [],
  minComposite: 0,
}

export function filterFunds(rows, filters) {
  const { query, categories, ratings, minComposite } = filters
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const categorySet = categories.length ? new Set(categories) : null
  const ratingSet = ratings.length ? new Set(ratings) : null

  return rows.filter((row) => {
    if (categorySet && !categorySet.has(row.category)) return false
    if (ratingSet && !ratingSet.has(row.rating)) return false
    if (minComposite > 0 && Number(row.composite) < minComposite) return false
    if (terms.length) {
      const text = haystack(row)
      // every term must appear, so "sbi mid" narrows rather than widens
      if (!terms.every((term) => text.includes(term))) return false
    }
    return true
  })
}

export function distinctValues(rows, key) {
  return [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  )
}

/* -------------------------------- sorting -------------------------------- */

/**
 * A sort key is either a plain row field, `score:<paramKey>` or
 * `value:<paramKey>` -- the same ids the table columns use, so a header click
 * needs no translation table.
 */
export function sortValueFor(row, sortKey) {
  if (sortKey.startsWith('score:')) return row.parameter_scores?.[sortKey.slice(6)] ?? null
  if (sortKey.startsWith('value:')) return metricSortValue(row, sortKey.slice(6))
  if (sortKey.startsWith('group:')) return row.category_scores?.[sortKey.slice(6)] ?? null
  if (sortKey === 'manager') return row.metrics?.['Fund Manager'] ?? ''
  if (sortKey === 'benchmark') return row.metrics?.['Benchmark Name'] ?? ''
  if (sortKey === 'p2pReturn') return row.p2pReturn?.return_pct ?? null
  return row[sortKey] ?? null
}

export function sortFunds(rows, sortKey, direction) {
  if (!sortKey) return rows
  const sign = direction === 'asc' ? 1 : -1

  // slice first: Array.prototype.sort mutates, and `rows` is derived state
  return rows.slice().sort((a, b) => {
    const left = sortValueFor(a, sortKey)
    const right = sortValueFor(b, sortKey)

    // blanks always sink to the bottom, whichever way the column is sorted
    const leftBlank = left === null || left === undefined || left === ''
    const rightBlank = right === null || right === undefined || right === ''
    if (leftBlank && rightBlank) return a.rank - b.rank
    if (leftBlank) return 1
    if (rightBlank) return -1

    if (typeof left === 'string' || typeof right === 'string') {
      const compared = String(left).localeCompare(String(right), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
      return compared !== 0 ? compared * sign : a.rank - b.rank
    }

    if (left === right) return a.rank - b.rank // stable, meaningful tiebreak
    return (Number(left) - Number(right)) * sign
  })
}

/* ------------------------------- exporting ------------------------------- */

/**
 * Every field the dashboard holds, in the column order of the two output
 * workbooks: fund identity, the composite block, then each parameter as a
 * score + its raw value. Independent of the on-screen view mode -- an export
 * should be complete -- but it does honour the active filter and sort.
 */
function csvColumns(paramColumns) {
  const columns = [
    { header: 'Rank', get: (row) => row.rank },
    { header: 'Scheme Code', get: (row) => row.schcode },
    { header: 'Fund Name', get: (row) => row.fund },
    { header: 'Category', get: (row) => row.category },
    { header: 'Fund Manager', get: (row) => row.metrics?.['Fund Manager'] },
    { header: 'Benchmark Name', get: (row) => row.metrics?.['Benchmark Name'] },
    { header: 'Composite Score', get: (row) => row.composite },
    { header: 'Rating', get: (row) => row.rating },
    { header: 'Recommendation', get: (row) => row.recommendation },
    { header: 'Data Completeness', get: (row) => formatCompleteness(row.data_completeness) },
  ]

  for (const group of ['Return', 'Risk', 'Cost & Operational', 'Portfolio & Structure', 'Fund Quality']) {
    columns.push({
      header: `${group} (avg score)`,
      get: (row) => row.category_scores?.[group],
    })
  }

  for (const column of paramColumns) {
    const spec = PARAM_METRICS[column.key]
    for (const metricKey of spec?.keys ?? []) {
      columns.push({ header: metricKey, get: (row) => row.metrics?.[metricKey] })
    }
    columns.push({
      header: `${column.label} — score`,
      get: (row) => row.parameter_scores?.[column.key],
    })
  }

  return columns
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  // quote when the value could otherwise break the row structure
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildCsv(rows, paramColumns) {
  const columns = csvColumns(paramColumns)
  const lines = [columns.map((column) => csvCell(column.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(column.get(row))).join(','))
  }
  return lines.join('\r\n')
}

/* Excel reads a CSV in the local codepage unless it sees a UTF-8 byte-order
   mark, which mangles the rupee sign and the em dashes in exit-load text. */
const UTF8_BOM = '\uFEFF'

export function downloadCsv(rows, paramColumns, filenameStem = 'equity_fund_scores') {
  const blob = new Blob([UTF8_BOM + buildCsv(rows, paramColumns)], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  anchor.href = url
  anchor.download = `${filenameStem}_${stamp}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/* ------------------------------- summarising ----------------------------- */

export function summarise(rows) {
  if (!rows.length) {
    return { count: 0, averageComposite: null, buyCount: 0, categoryCount: 0, topRating: null }
  }
  const total = rows.reduce((sum, row) => sum + Number(row.composite ?? 0), 0)
  const buyCount = rows.filter((row) => row.recommendation?.includes('Buy')).length
  return {
    count: rows.length,
    averageComposite: formatNumber(total / rows.length),
    buyCount,
    categoryCount: new Set(rows.map((row) => row.category)).size,
    topRating: rows[0]?.rating ?? null,
  }
}
