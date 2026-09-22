import { useCallback, useMemo, useState } from 'react'

import { postPointToPointReturns } from './api/fundsApi'
import AppHeader from './components/AppHeader'
import { ConnectionBanner, StaleDataBanner } from './components/Banner'
import FundCards from './components/FundCards'
import FundModal from './components/FundModal'
import FundTable from './components/FundTable'
import Pagination from './components/Pagination'
import SummaryCards from './components/SummaryCards'
import Toolbar from './components/Toolbar'
import { EmptyState, TableSkeleton } from './components/primitives'
import { useDebouncedValue } from './hooks/useDebouncedValue'
import { useFundData } from './hooks/useFundData'
import { useIsCompact } from './hooks/useMediaQuery'
import { useTheme } from './hooks/useTheme'
import { RATING_TONES } from './lib/columns'
import {
  EMPTY_FILTERS,
  FUND_INFO_GROUP,
  distinctValues,
  downloadCsv,
  filterFunds,
  sortFunds,
  summarise,
} from './lib/fundsView'
import styles from './App.module.css'

const DEFAULT_SORT = { key: 'composite', direction: 'desc' }

/**
 * One-click filter combinations. Each declares the complete filter state it
 * represents, so "is this preset active?" is derived by comparing against the
 * live filters rather than tracked in a second piece of state that could drift.
 */
const PRESETS = [
  {
    id: 'top-rated',
    label: 'Top rated',
    hint: 'Only funds rated Outstanding or Excellent',
    filters: { ratings: ['Outstanding', 'Excellent'] },
  },
  {
    id: 'score-4',
    label: 'Score 4+',
    hint: 'Composite score of 4.00 and above',
    filters: { minComposite: 4 },
  },
  {
    id: 'large-cap',
    label: 'Large caps',
    hint: 'Large Cap and Large & Mid Cap funds',
    filters: { categories: ['Large Cap Fund', 'Large & Mid Cap Fund'] },
  },
  {
    id: 'small-mid',
    label: 'Small & mid',
    hint: 'Small Cap and Mid Cap funds',
    filters: { categories: ['Small Cap Fund', 'Mid Cap Fund'] },
  },
]

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value))

export default function App() {
  const {
    funds,
    columns,
    groups,
    lastUpdated,
    nextRefreshAt,
    serverError,
    sourceMode,
    error,
    isLoading,
    isRefreshing,
    refresh,
  } = useFundData()

  const { theme, cycleTheme } = useTheme()
  const isCompact = useIsCompact()

  const [query, setQuery] = useState('')
  const [selectedCategories, setSelectedCategories] = useState([])
  const [selectedRatings, setSelectedRatings] = useState([])
  const [minComposite, setMinComposite] = useState(0)
  const [sort, setSort] = useState(DEFAULT_SORT)
  const [viewMode, setViewMode] = useState('scores')
  const [hiddenGroups, setHiddenGroups] = useState([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [selectedId, setSelectedId] = useState(null)

  const [returnRange, setReturnRange] = useState(null)
  const [p2pReturns, setP2pReturns] = useState(null)
  const [returnsLoading, setReturnsLoading] = useState(false)
  const [returnsError, setReturnsError] = useState(null)

  const debouncedQuery = useDebouncedValue(query, 200)

  const categoryOptions = useMemo(() => distinctValues(funds, 'category'), [funds])
  const ratingOptions = useMemo(() => {
    // matrix order (best first), not alphabetical
    const present = new Set(funds.map((row) => row.rating))
    return Object.keys(RATING_TONES).filter((rating) => present.has(rating))
  }, [funds])

  const filters = useMemo(
    () => ({
      ...EMPTY_FILTERS,
      query: debouncedQuery,
      categories: selectedCategories,
      ratings: selectedRatings,
      minComposite,
    }),
    [debouncedQuery, selectedCategories, selectedRatings, minComposite],
  )

  const filtered = useMemo(() => filterFunds(funds, filters), [funds, filters])

  /* p2pReturn is merged in before sorting (not after) so a header click can
     sort by it like any other column -- see sortValueFor() in fundsView.js. */
  const withReturns = useMemo(() => {
    if (!p2pReturns) return filtered
    return filtered.map((row) => ({ ...row, p2pReturn: p2pReturns[String(row.schcode)] ?? null }))
  }, [filtered, p2pReturns])

  const sorted = useMemo(
    () => sortFunds(withReturns, sort.key, sort.direction),
    [withReturns, sort],
  )

  const summary = useMemo(() => summarise(sorted), [sorted])
  const ratingCounts = useMemo(() => {
    const counts = new Map()
    for (const row of sorted) counts.set(row.rating, (counts.get(row.rating) ?? 0) + 1)
    return Object.keys(RATING_TONES)
      .filter((rating) => counts.has(rating))
      .map((rating) => ({ rating, count: counts.get(rating), tone: RATING_TONES[rating] }))
  }, [sorted])

  const visibleGroups = useMemo(
    () => [FUND_INFO_GROUP, ...groups].filter((group) => !hiddenGroups.includes(group)),
    [groups, hiddenGroups],
  )

  /* The page is clamped as it is read rather than corrected by an effect: a
     filter that shrinks the result set below the current page would otherwise
     render one empty frame before snapping back. */
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, totalPages)

  const pageRows = useMemo(
    () => sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [sorted, currentPage, pageSize],
  )

  /* Every control that changes which rows exist also returns to page 1 --
     done in the handler, where the intent is, not in an effect watching state. */
  const handleQueryChange = useCallback((value) => {
    setQuery(value)
    setPage(1)
  }, [])

  const handleCategoriesChange = useCallback((value) => {
    setSelectedCategories(value)
    setPage(1)
  }, [])

  const handleRatingsChange = useCallback((value) => {
    setSelectedRatings(value)
    setPage(1)
  }, [])

  const handleToggleRating = useCallback((rating) => {
    setSelectedRatings((current) =>
      current.includes(rating) ? current.filter((item) => item !== rating) : [...current, rating],
    )
    setPage(1)
  }, [])

  const handleMinCompositeChange = useCallback((value) => {
    setMinComposite(value)
    setPage(1)
  }, [])

  const handlePageSizeChange = useCallback((value) => {
    setPageSize(value)
    setPage(1)
  }, [])

  const handleSort = useCallback((key) => {
    setSort((current) => {
      if (current.key !== key) {
        // text sorts read better A->Z first; scores read better best-first
        const textual =
          key === 'fund' || key === 'category' || key === 'manager' || key === 'benchmark'
        return { key, direction: textual ? 'asc' : 'desc' }
      }
      return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' }
    })
    setPage(1)
  }, [])

  const handleToggleGroup = useCallback((group) => {
    setHiddenGroups((current) =>
      current.includes(group) ? current.filter((item) => item !== group) : [...current, group],
    )
  }, [])

  /* Fetched against the currently filtered (not yet paginated/sorted-by-return)
     set -- a live bulk network call, one HTTP request per scheme on the
     backend, so it only runs when the user explicitly asks for a range. */
  const handleApplyReturnRange = useCallback(
    async (range) => {
      setReturnRange(range)
      setReturnsLoading(true)
      setReturnsError(null)
      try {
        const schcodes = filtered.map((row) => row.schcode)
        const { returns } = await postPointToPointReturns({
          schcodes,
          startDate: range.startDate,
          endDate: range.endDate,
        })
        setP2pReturns(returns)
      } catch (err) {
        setReturnsError(err.message || 'Failed to load returns')
        setP2pReturns(null)
      } finally {
        setReturnsLoading(false)
      }
    },
    [filtered],
  )

  const handleClearReturnRange = useCallback(() => {
    setReturnRange(null)
    setP2pReturns(null)
    setReturnsError(null)
  }, [])

  const handleReset = useCallback(() => {
    setQuery('')
    setSelectedCategories([])
    setSelectedRatings([])
    setMinComposite(0)
    setSort(DEFAULT_SORT)
    setPage(1)
  }, [])

  /* A preset replaces the whole filter set, and clicking the active one clears
     it -- so the chips behave as toggles rather than accumulating state. */
  const activePresetId = useMemo(() => {
    if (query) return null
    const match = PRESETS.find((preset) => {
      const wanted = { categories: [], ratings: [], minComposite: 0, ...preset.filters }
      return (
        sameSet(selectedCategories, wanted.categories) &&
        sameSet(selectedRatings, wanted.ratings) &&
        minComposite === wanted.minComposite
      )
    })
    return match?.id ?? null
  }, [query, selectedCategories, selectedRatings, minComposite])

  const handleApplyPreset = useCallback(
    (preset) => {
      const clearing = activePresetId === preset.id
      const wanted = clearing
        ? { categories: [], ratings: [], minComposite: 0 }
        : { categories: [], ratings: [], minComposite: 0, ...preset.filters }
      setSelectedCategories(wanted.categories)
      setSelectedRatings(wanted.ratings)
      setMinComposite(wanted.minComposite)
      setQuery('')
      setPage(1)
    },
    [activePresetId],
  )

  const handleExport = useCallback(() => downloadCsv(sorted, columns), [sorted, columns])

  /* Modal navigation walks the full sorted result set, not just the page, so
     arrowing past row 50 continues rather than dead-ends. */
  const selectedIndex = useMemo(
    () => (selectedId === null ? -1 : sorted.findIndex((row) => row.schcode === selectedId)),
    [sorted, selectedId],
  )
  const selectedRow = selectedIndex >= 0 ? sorted[selectedIndex] : null

  const handleSelect = useCallback((row) => setSelectedId(row.schcode), [])
  const handleCloseModal = useCallback(() => setSelectedId(null), [])
  const handlePrev = useCallback(
    () => setSelectedId(sorted[selectedIndex - 1].schcode),
    [sorted, selectedIndex],
  )
  const handleNext = useCallback(
    () => setSelectedId(sorted[selectedIndex + 1].schcode),
    [sorted, selectedIndex],
  )

  const hasActiveFilters =
    Boolean(query) || selectedCategories.length > 0 || selectedRatings.length > 0 || minComposite > 0

  const showSkeleton = isLoading && funds.length === 0

  return (
    <div className={styles.app}>
      <AppHeader
        lastUpdated={lastUpdated}
        nextRefreshAt={nextRefreshAt}
        fundCount={funds.length}
        paramCount={columns.length}
        sourceMode={sourceMode}
        serverError={serverError}
        isRefreshing={isRefreshing}
        onRefresh={refresh}
        theme={theme}
        onCycleTheme={cycleTheme}
      />

      <main className={styles.main}>
        {error ? (
          <ConnectionBanner error={error} onRetry={refresh} hasCachedRows={funds.length > 0} />
        ) : null}

        {serverError && !error ? (
          <StaleDataBanner serverError={serverError} lastUpdated={lastUpdated} onRetry={refresh} />
        ) : null}

        {!showSkeleton ? (
          <SummaryCards
            summary={summary}
            ratingCounts={ratingCounts}
            totalCount={funds.length}
            selectedRatings={selectedRatings}
            onToggleRating={handleToggleRating}
          />
        ) : null}

        <section className={styles.panel}>
          <Toolbar
            query={query}
            onQueryChange={handleQueryChange}
            categories={categoryOptions}
            selectedCategories={selectedCategories}
            onCategoriesChange={handleCategoriesChange}
            ratings={ratingOptions}
            selectedRatings={selectedRatings}
            onRatingsChange={handleRatingsChange}
            minComposite={minComposite}
            onMinCompositeChange={handleMinCompositeChange}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            groups={groups}
            visibleGroups={visibleGroups}
            onToggleGroup={handleToggleGroup}
            presets={PRESETS}
            activePresetId={activePresetId}
            onApplyPreset={handleApplyPreset}
            onExport={handleExport}
            onReset={handleReset}
            hasActiveFilters={hasActiveFilters}
            resultCount={sorted.length}
            isCompact={isCompact}
            returnRange={returnRange}
            returnsLoading={returnsLoading}
            returnsError={returnsError}
            onApplyReturnRange={handleApplyReturnRange}
            onClearReturnRange={handleClearReturnRange}
          />

          {showSkeleton ? (
            <TableSkeleton />
          ) : sorted.length === 0 ? (
            <EmptyState
              title="No funds match these filters"
              description={
                funds.length === 0
                  ? 'The scoring API returned no funds. Check the backend logs for a failed refresh.'
                  : 'Try widening the composite threshold or clearing a category or rating filter.'
              }
              action={
                hasActiveFilters ? (
                  <button type="button" className={styles.resetButton} onClick={handleReset}>
                    Clear all filters
                  </button>
                ) : null
              }
            />
          ) : (
            <>
              {isCompact ? (
                <FundCards
                  rows={pageRows}
                  paramColumns={columns}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                />
              ) : (
                <FundTable
                  rows={pageRows}
                  paramColumns={columns}
                  viewMode={viewMode}
                  visibleGroups={visibleGroups}
                  sortKey={sort.key}
                  sortDirection={sort.direction}
                  onSort={handleSort}
                  selectedId={selectedId}
                  onSelect={handleSelect}
                  returnColumnLabel={returnRange ? returnRange.label ?? 'Custom' : null}
                />
              )}

              <Pagination
                page={currentPage}
                pageSize={pageSize}
                totalRows={sorted.length}
                onPageChange={setPage}
                onPageSizeChange={handlePageSizeChange}
              />
            </>
          )}
        </section>

        <footer className={styles.footer}>
          <p>
            Scored on {columns.length} parameters from the Arihant mutual fund scoring matrix. Composite is
            the weighted mean of the parameters that could be scored; ratings follow the matrix’s own
            bands.
          </p>
          <p className={styles.footerNote}>
            Data refreshes automatically once a day. This page re-checks when you return to the tab,
            and only when a new refresh is actually due.
          </p>
        </footer>
      </main>

      {selectedRow ? (
        <FundModal
          row={selectedRow}
          position={selectedIndex + 1}
          total={sorted.length}
          paramColumns={columns}
          onClose={handleCloseModal}
          onPrev={selectedIndex > 0 ? handlePrev : undefined}
          onNext={selectedIndex < sorted.length - 1 ? handleNext : undefined}
        />
      ) : null}
    </div>
  )
}
