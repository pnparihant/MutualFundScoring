import { useEffect, useRef, useState } from 'react'

import { RETURN_RANGE_PRESETS, todayISODate, trailingRange } from '../lib/dateRanges'
import { FUND_INFO_GROUP } from '../lib/fundsView'
import { CalendarIcon, CloseIcon, DownloadIcon, LayersIcon, SearchIcon, SparkIcon } from './icons'
import MultiSelect from './MultiSelect'
import styles from './Toolbar.module.css'

const VIEW_MODES = [
  { id: 'scores', label: 'Scores', hint: 'Show the 1–5 band each parameter scored' },
  { id: 'values', label: 'Values', hint: 'Show the raw figure each score came from' },
  { id: 'both', label: 'Both', hint: 'Score with its raw value underneath' },
]

export default function Toolbar({
  query,
  onQueryChange,
  categories,
  selectedCategories,
  onCategoriesChange,
  ratings,
  selectedRatings,
  onRatingsChange,
  minComposite,
  onMinCompositeChange,
  viewMode,
  onViewModeChange,
  groups,
  visibleGroups,
  onToggleGroup,
  presets,
  activePresetId,
  onApplyPreset,
  onExport,
  onReset,
  hasActiveFilters,
  resultCount,
  isCompact,
  returnRange,
  returnsLoading,
  returnsError,
  onApplyReturnRange,
  onClearReturnRange,
}) {
  const searchRef = useRef(null)
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState(todayISODate())

  const activePresetMonths = returnRange?.months ?? null

  const handlePresetClick = (preset) => {
    const { startDate, endDate } = trailingRange(preset.months)
    setCustomStart(startDate)
    setCustomEnd(endDate)
    onApplyReturnRange({ startDate, endDate, label: preset.label, months: preset.months })
  }

  const handleCustomApply = () => {
    if (!customStart || !customEnd || customStart >= customEnd) return
    onApplyReturnRange({ startDate: customStart, endDate: customEnd, label: null, months: null })
  }

  const customValid = customStart && customEnd && customStart < customEnd

  /* "/" to search is the convention for data-dense tools; Escape clears. */
  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target
      const typingElsewhere =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)

      if (event.key === '/' && !typingElsewhere) {
        event.preventDefault()
        searchRef.current?.focus()
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        onQueryChange('')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onQueryChange])

  const allGroups = [FUND_INFO_GROUP, ...groups]

  return (
    <div className={styles.toolbar}>
      <div className={styles.searchRow}>
        <div className={styles.search}>
          <SearchIcon width={18} height={18} className={styles.searchIcon} />
          <input
            ref={searchRef}
            type="search"
            className={styles.searchInput}
            placeholder="Search fund, manager, benchmark or scheme code…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-label="Search funds"
          />
          {query ? (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
            >
              <CloseIcon width={16} height={16} />
            </button>
          ) : (
            <kbd className={styles.kbd}>/</kbd>
          )}
        </div>

        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.button}
            onClick={onExport}
            disabled={resultCount === 0}
          >
            <DownloadIcon width={16} height={16} />
            <span className={styles.buttonText}>Export CSV</span>
          </button>
          {hasActiveFilters ? (
            <button type="button" className={styles.buttonGhost} onClick={onReset}>
              <CloseIcon width={14} height={14} />
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.filterRow}>
        <MultiSelect
          label="Category"
          options={categories}
          selected={selectedCategories}
          onChange={onCategoriesChange}
          allLabel="All categories"
        />

        <MultiSelect
          label="Rating"
          options={ratings}
          selected={selectedRatings}
          onChange={onRatingsChange}
          allLabel="All ratings"
        />

        <label className={styles.slider}>
          <span className={styles.sliderLabel}>Min score</span>
          <input
            type="range"
            min="0"
            max="5"
            step="0.25"
            value={minComposite}
            onChange={(event) => onMinCompositeChange(Number(event.target.value))}
            className={styles.range}
            style={{ '--fill': `${(minComposite / 5) * 100}%` }}
          />
          <output className={styles.sliderValue}>
            {minComposite === 0 ? 'any' : minComposite.toFixed(2)}
          </output>
        </label>

        <div className={styles.presets}>
          <SparkIcon width={15} height={15} className={styles.presetIcon} />
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`${styles.preset} ${
                activePresetId === preset.id ? styles.presetActive : ''
              }`}
              onClick={() => onApplyPreset(preset)}
              aria-pressed={activePresetId === preset.id}
              title={preset.hint}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.returnsRow}>
        <CalendarIcon width={15} height={15} className={styles.returnsIcon} />
        <span className={styles.returnsLabel}>Point-to-point return</span>

        <div className={styles.presets}>
          {RETURN_RANGE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`${styles.preset} ${
                activePresetMonths === preset.months ? styles.presetActive : ''
              }`}
              onClick={() => handlePresetClick(preset)}
              aria-pressed={activePresetMonths === preset.months}
              title={`Trailing ${preset.label} return, from today`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className={styles.returnsCustom}>
          <input
            type="date"
            className={styles.dateInput}
            value={customStart}
            max={customEnd || undefined}
            onChange={(event) => setCustomStart(event.target.value)}
            aria-label="Return range start date"
          />
          <span className={styles.returnsCustomSep}>to</span>
          <input
            type="date"
            className={styles.dateInput}
            value={customEnd}
            min={customStart || undefined}
            max={todayISODate()}
            onChange={(event) => setCustomEnd(event.target.value)}
            aria-label="Return range end date"
          />
          <button
            type="button"
            className={styles.button}
            onClick={handleCustomApply}
            disabled={!customValid || returnsLoading}
          >
            {returnsLoading ? 'Loading…' : 'Show returns'}
          </button>
          {returnRange ? (
            <button type="button" className={styles.buttonGhost} onClick={onClearReturnRange}>
              <CloseIcon width={14} height={14} />
              Clear
            </button>
          ) : null}
        </div>

        {returnsError ? <span className={styles.returnsError}>{returnsError}</span> : null}
      </div>

      <div className={styles.displayRow}>
        <div className={styles.segmented} role="group" aria-label="Parameter display">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`${styles.segment} ${viewMode === mode.id ? styles.segmentActive : ''}`}
              onClick={() => onViewModeChange(mode.id)}
              title={mode.hint}
              aria-pressed={viewMode === mode.id}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {!isCompact ? (
          <div className={styles.groupToggles}>
            <LayersIcon width={15} height={15} className={styles.groupIcon} />
            <span className={styles.groupCaption}>Columns</span>
            {allGroups.map((group) => {
              const active = visibleGroups.includes(group)
              return (
                <button
                  key={group}
                  type="button"
                  className={`${styles.chip} ${active ? styles.chipActive : ''}`}
                  onClick={() => onToggleGroup(group)}
                  aria-pressed={active}
                  title={`${active ? 'Hide' : 'Show'} the ${group} columns`}
                >
                  {group}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}
