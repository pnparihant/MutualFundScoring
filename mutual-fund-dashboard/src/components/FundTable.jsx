import { memo, useCallback, useMemo, useRef, useState } from 'react'

import { metricSummary } from '../lib/columns'
import { DASH, formatPercent } from '../lib/format'
import { FUND_INFO_GROUP } from '../lib/fundsView'
import { ArrowDownIcon, ArrowUpIcon, ExpandIcon } from './icons'
import {
  CompletenessMeter,
  CompositeScore,
  RatingPill,
  RecommendationPill,
  ScoreBadge,
} from './primitives'
import styles from './FundTable.module.css'

/**
 * The scored universe as a table.
 *
 * Column definitions are built once from the API's `columns` metadata and shared
 * by the header, the body and the sort handler, so there is a single source of
 * truth for what a column is called, which group it belongs to and what it sorts
 * by. `viewMode` decides whether a parameter cell shows its 1-5 score, the raw
 * value it was scored from, or both.
 *
 * Selecting a row opens FundModal — the detail is a dialog, not an inline
 * expansion, so it never pushes the table around or gets lost off to the side
 * once the table is scrolled horizontally.
 */

const STAGGER_STEP_MS = 18
const STAGGER_CAP_MS = 320

const RETURN_GROUP = 'Point-to-Point Return'

function ReturnCell({ value }) {
  if (!value) return <span className={styles.numeric}>{DASH}</span>
  return (
    <span className={styles.numeric} title={`${value.start_date} → ${value.end_date}`}>
      {value.return_pct > 0 ? '+' : ''}
      {formatPercent(value.return_pct)}
    </span>
  )
}

const IDENTITY_COLUMNS = [
  {
    id: 'category',
    label: 'Category',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => <span className={styles.category}>{row.category || DASH}</span>,
  },
  {
    id: 'composite',
    label: 'Composite',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => <CompositeScore value={row.composite} />,
  },
  {
    id: 'rating',
    label: 'Rating',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => <RatingPill rating={row.rating} />,
  },
  {
    id: 'recommendation',
    label: 'Recommendation',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => <RecommendationPill recommendation={row.recommendation} />,
  },
  {
    id: 'manager',
    label: 'Fund Manager',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => (
      <span className={styles.truncate} title={row.metrics?.['Fund Manager'] || ''}>
        {row.metrics?.['Fund Manager'] || DASH}
      </span>
    ),
  },
  {
    id: 'benchmark',
    label: 'Benchmark',
    group: FUND_INFO_GROUP,
    align: 'left',
    render: (row) => (
      <span className={styles.truncate} title={row.metrics?.['Benchmark Name'] || ''}>
        {row.metrics?.['Benchmark Name'] || DASH}
      </span>
    ),
  },
  {
    id: 'data_completeness',
    label: 'Data',
    group: FUND_INFO_GROUP,
    align: 'left',
    title: 'Share of the weighted parameters that could be scored',
    render: (row) => <CompletenessMeter value={row.data_completeness} />,
  },
]

function ParameterCell({ row, paramKey, viewMode }) {
  const score = row.parameter_scores?.[paramKey]
  const value = metricSummary(row, paramKey)
  const isText = paramKey === 'exit_load_structure'

  if (viewMode === 'scores') return <ScoreBadge score={score} />

  if (viewMode === 'values') {
    return (
      <span
        className={isText ? styles.truncate : styles.numeric}
        title={isText ? value : undefined}
      >
        {value}
      </span>
    )
  }

  return (
    <span className={styles.stack}>
      <ScoreBadge score={score} size="sm" />
      <span className={styles.stackValue} title={isText ? value : undefined}>
        {value}
      </span>
    </span>
  )
}

function buildColumns(paramColumns, viewMode, visibleGroups, returnColumnLabel) {
  const columns = IDENTITY_COLUMNS.filter(() => visibleGroups.includes(FUND_INFO_GROUP))

  const parameterColumns = paramColumns
    .filter((column) => visibleGroups.includes(column.group))
    .map((column) => ({
      id: viewMode === 'values' ? `value:${column.key}` : `score:${column.key}`,
      label: column.label,
      group: column.group,
      align: viewMode === 'values' && column.key === 'exit_load_structure' ? 'left' : 'center',
      title: `Weight ${(column.weight * 100).toFixed(1)}% of the composite`,
      wide: column.key === 'exit_load_structure' && viewMode !== 'scores',
      render: (row) => <ParameterCell row={row} paramKey={column.key} viewMode={viewMode} />,
    }))

  /* Not backend-driven like the parameter columns above -- an on-demand
     column that only exists once the user has asked for a date range (see
     Toolbar's point-to-point return control), so it isn't gated by
     visibleGroups the way the scored parameter groups are. */
  const returnColumn = returnColumnLabel
    ? [
        {
          id: 'p2pReturn',
          label: `Return (${returnColumnLabel})`,
          group: RETURN_GROUP,
          align: 'center',
          title: 'Point-to-point return for the selected date range',
          render: (row) => <ReturnCell value={row.p2pReturn} />,
        },
      ]
    : []

  return [...columns, ...parameterColumns, ...returnColumn]
}

function SortIndicator({ state }) {
  if (state === 'asc') return <ArrowUpIcon width={13} height={13} className={styles.sortIcon} />
  if (state === 'desc') return <ArrowDownIcon width={13} height={13} className={styles.sortIcon} />
  return <span className={styles.sortPlaceholder} aria-hidden="true" />
}

function HeaderCell({ column, sortKey, sortDirection, onSort }) {
  const active = sortKey === column.id
  return (
    <th
      scope="col"
      className={`${styles.th} ${column.align === 'center' ? styles.center : ''} ${
        column.wide ? styles.wide : ''
      } ${active ? styles.thActive : ''}`}
      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={styles.sortButton}
        onClick={() => onSort(column.id)}
        title={column.title ? `${column.label} — ${column.title}` : `Sort by ${column.label}`}
      >
        <span className={styles.thLabel}>{column.label}</span>
        <SortIndicator state={active ? sortDirection : null} />
      </button>
    </th>
  )
}

const FundRow = memo(function FundRow({ row, columns, index, isActive, isSelected, onSelect }) {
  return (
    <tr
      className={`${styles.tr} ${isActive ? styles.trActive : ''} ${
        isSelected ? styles.trSelected : ''
      }`}
      style={{ animationDelay: `${Math.min(index * STAGGER_STEP_MS, STAGGER_CAP_MS)}ms` }}
      onClick={() => onSelect(row)}
    >
      <td className={`${styles.td} ${styles.rankCell} ${styles.stickyRank}`}>
        <span className={styles.rank}>{row.rank}</span>
      </td>

      <td className={`${styles.td} ${styles.stickyFund}`}>
        {/* A real button, so the row is reachable and activatable by keyboard
            without turning the whole table into an ARIA grid. */}
        <button
          type="button"
          className={styles.fundButton}
          onClick={(event) => {
            event.stopPropagation()
            onSelect(row)
          }}
        >
          <span className={styles.fundName} title={row.fund}>
            {row.fund}
          </span>
          <span className={styles.fundMeta}>
            <span className={styles.schcode}>#{row.schcode}</span>
            <ExpandIcon width={13} height={13} className={styles.expandHint} />
          </span>
        </button>
      </td>

      {columns.map((column) => (
        <td
          key={column.id}
          className={`${styles.td} ${column.align === 'center' ? styles.center : ''} ${
            column.wide ? styles.wide : ''
          }`}
        >
          {column.render(row)}
        </td>
      ))}
    </tr>
  )
})

export default function FundTable({
  rows,
  paramColumns,
  viewMode,
  visibleGroups,
  sortKey,
  sortDirection,
  onSort,
  selectedId,
  onSelect,
  returnColumnLabel,
}) {
  const scrollerRef = useRef(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  const columns = useMemo(
    () => buildColumns(paramColumns, viewMode, visibleGroups, returnColumnLabel),
    [paramColumns, viewMode, visibleGroups, returnColumnLabel],
  )

  /* Group header row: one cell per run of columns sharing a group. */
  const groupSpans = useMemo(() => {
    const spans = []
    for (const column of columns) {
      const last = spans[spans.length - 1]
      if (last && last.group === column.group) last.span += 1
      else spans.push({ group: column.group, span: 1 })
    }
    return spans
  }, [columns])

  /* The pinned rank/fund columns belong to Fund Info -- unless the user has
     hidden that group, in which case they stand alone. */
  const stickyGroupLabel = groupSpans[0]?.group === FUND_INFO_GROUP ? FUND_INFO_GROUP : 'Fund'

  /* Clamped as it is read rather than reset by an effect, so a filter that
     shrinks the list can't leave the cursor pointing past the end. */
  const active = activeIndex >= rows.length ? -1 : activeIndex

  const moveActive = useCallback(
    (nextIndex) => {
      const clamped = Math.max(0, Math.min(nextIndex, rows.length - 1))
      setActiveIndex(clamped)
      const tbody = scrollerRef.current?.querySelector('tbody')
      tbody?.children[clamped]?.scrollIntoView({ block: 'nearest' })
    },
    [rows.length],
  )

  /* Arrow-key row navigation, scoped to the scroller so it can't fight the
     modal's own left/right handling or steal keys from the search box. */
  const onKeyDown = useCallback(
    (event) => {
      if (!rows.length) return
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          moveActive(active < 0 ? 0 : active + 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          moveActive(active < 0 ? 0 : active - 1)
          break
        case 'Home':
          event.preventDefault()
          moveActive(0)
          break
        case 'End':
          event.preventDefault()
          moveActive(rows.length - 1)
          break
        case 'Enter':
          if (active >= 0) {
            event.preventDefault()
            onSelect(rows[active])
          }
          break
        default:
      }
    },
    [rows, active, moveActive, onSelect],
  )

  return (
    <div
      className={styles.scroller}
      role="region"
      aria-label="Fund scores — use arrow keys to move between rows, Enter to open"
      tabIndex={0}
      ref={scrollerRef}
      onKeyDown={onKeyDown}
    >
      <table className={styles.table}>
        <colgroup>
          <col className={styles.colRank} />
          <col className={styles.colFund} />
          {columns.map((column) => (
            <col key={column.id} className={column.wide ? styles.colWide : undefined} />
          ))}
        </colgroup>

        <thead>
          <tr className={styles.groupRow}>
            {/* The pinned columns need their own cell (a colSpan can't be sticky
                across the boundary), so this carries the group name and the
                adjacent run of the same group renders as a silent continuation
                -- otherwise the row reads "FUND | FUND INFO". */}
            <th
              className={`${styles.groupTh} ${styles.stickyRank} ${styles.groupFundInfo}`}
              colSpan={2}
              scope="col"
            >
              {stickyGroupLabel}
            </th>
            {groupSpans.map((span, index) => {
              const isContinuation = index === 0 && span.group === stickyGroupLabel
              return (
                <th
                  key={`${span.group}-${index}`}
                  className={`${styles.groupTh} ${
                    styles[`group${span.group.replace(/[^a-zA-Z]/g, '')}`] ?? ''
                  }`}
                  colSpan={span.span}
                  scope="colgroup"
                  aria-label={isContinuation ? span.group : undefined}
                >
                  {isContinuation ? '' : span.group}
                </th>
              )
            })}
          </tr>

          <tr>
            <th scope="col" className={`${styles.th} ${styles.stickyRank}`}>
              <span className={styles.thStatic}>#</span>
            </th>
            <th
              scope="col"
              className={`${styles.th} ${styles.stickyFund} ${
                sortKey === 'fund' ? styles.thActive : ''
              }`}
              aria-sort={
                sortKey === 'fund'
                  ? sortDirection === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              }
            >
              <button type="button" className={styles.sortButton} onClick={() => onSort('fund')}>
                <span className={styles.thLabel}>Fund Name</span>
                <SortIndicator state={sortKey === 'fund' ? sortDirection : null} />
              </button>
            </th>
            {columns.map((column) => (
              <HeaderCell
                key={column.id}
                column={column}
                sortKey={sortKey}
                sortDirection={sortDirection}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row, index) => (
            <FundRow
              key={row.schcode}
              row={row}
              index={index}
              columns={columns}
              isActive={index === active}
              isSelected={row.schcode === selectedId}
              onSelect={onSelect}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
