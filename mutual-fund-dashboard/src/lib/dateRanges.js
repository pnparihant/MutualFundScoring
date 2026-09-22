/** Trailing-window presets for the point-to-point return feature. */
export const RETURN_RANGE_PRESETS = [
  { id: '1m', label: '1M', months: 1 },
  { id: '2m', label: '2M', months: 2 },
  { id: '3m', label: '3M', months: 3 },
  { id: '6m', label: '6M', months: 6 },
  { id: '1y', label: '1Y', months: 12 },
]

function toISODate(date) {
  return date.toISOString().slice(0, 10)
}

function subMonths(date, months) {
  const d = new Date(date)
  d.setMonth(d.getMonth() - months)
  return d
}

/** {startDate, endDate} as YYYY-MM-DD strings, `months` back from today. */
export function trailingRange(months) {
  const end = new Date()
  const start = subMonths(end, months)
  return { startDate: toISODate(start), endDate: toISODate(end) }
}

export function todayISODate() {
  return toISODate(new Date())
}
