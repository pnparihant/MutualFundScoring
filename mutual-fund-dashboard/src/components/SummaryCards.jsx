import { ToneDot } from './primitives'
import styles from './SummaryCards.module.css'

/**
 * Headline numbers for whatever is currently filtered, not for the whole
 * universe -- so narrowing to "Small Cap, rated Good+" immediately shows what
 * that slice looks like.
 *
 * The rating spread doubles as a filter: each row is a button that toggles that
 * rating, which is faster than opening the Rating dropdown and is the obvious
 * gesture once you've read the distribution.
 */
export default function SummaryCards({
  summary,
  ratingCounts,
  totalCount,
  selectedRatings,
  onToggleRating,
}) {
  const isFiltered = summary.count !== totalCount
  const buyShare = summary.count ? Math.round((summary.buyCount / summary.count) * 100) : 0

  return (
    <div className={styles.cards}>
      <div className={styles.card}>
        <span className={styles.label}>Funds shown</span>
        <span className={styles.value}>{summary.count.toLocaleString('en-IN')}</span>
        <span className={styles.hint}>
          {isFiltered ? `filtered from ${totalCount.toLocaleString('en-IN')}` : 'the full universe'}
        </span>
      </div>

      <div className={styles.card}>
        <span className={styles.label}>Average composite</span>
        <span className={`${styles.value} ${styles.valueBrand}`}>
          {summary.averageComposite ?? '—'}
        </span>
        <span className={styles.hint}>out of 5.00</span>
      </div>

      <div className={styles.card}>
        <span className={styles.label}>Buy-side calls</span>
        <span className={styles.value}>{summary.buyCount.toLocaleString('en-IN')}</span>
        <span className={styles.meter} aria-hidden="true">
          <span className={styles.meterFill} style={{ width: `${buyShare}%` }} />
        </span>
        <span className={styles.hint}>{summary.count ? `${buyShare}% of shown` : '—'}</span>
      </div>

      <div className={styles.card}>
        <span className={styles.label}>Categories</span>
        <span className={styles.value}>{summary.categoryCount}</span>
        <span className={styles.hint}>fund sub-categories</span>
      </div>

      <div className={`${styles.card} ${styles.cardWide}`}>
        <span className={styles.label}>Rating spread</span>
        <span className={styles.spreadHint}>click a rating to filter</span>
        <ul className={styles.spread}>
          {ratingCounts.map(({ rating, count, tone }) => {
            const active = selectedRatings.includes(rating)
            const share = summary.count ? (count / summary.count) * 100 : 0
            return (
              <li key={rating}>
                <button
                  type="button"
                  className={`${styles.spreadItem} ${active ? styles.spreadItemActive : ''}`}
                  onClick={() => onToggleRating(rating)}
                  aria-pressed={active}
                  title={`${active ? 'Remove' : 'Add'} the ${rating} filter`}
                >
                  <ToneDot tone={tone} label={rating} />
                  <span className={styles.spreadLabel}>{rating}</span>
                  <span className={styles.spreadCount}>{count.toLocaleString('en-IN')}</span>
                  <span className={styles.spreadBar} aria-hidden="true">
                    <span
                      className={`${styles.spreadBarFill} ${styles[`fill${tone}`]}`}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
