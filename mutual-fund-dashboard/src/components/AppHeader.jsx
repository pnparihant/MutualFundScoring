import { formatDateTime, formatRelative } from '../lib/format'
import ArihantLogo from './ArihantLogo'
import { AlertIcon, ClockIcon, MonitorIcon, MoonIcon, RefreshIcon, SunIcon } from './icons'
import { Badge, Spinner } from './primitives'
import styles from './AppHeader.module.css'

const THEME_ICONS = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
}

const THEME_LABELS = {
  system: 'Theme: match system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

export default function AppHeader({
  lastUpdated,
  nextRefreshAt,
  fundCount,
  paramCount,
  sourceMode,
  serverError,
  isRefreshing,
  onRefresh,
  theme,
  onCycleTheme,
}) {
  const ThemeIcon = THEME_ICONS[theme]
  const isFixture = sourceMode && Object.values(sourceMode).some((mode) => mode === 'fixture')

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <a className={styles.logoLink} href="/" aria-label="Arihant Capital — Mutual Fund Scoring">
          <ArihantLogo variant="full" className={styles.logo} />
        </a>
        <span className={styles.divider} aria-hidden="true" />
        <div className={styles.titles}>
          <h1 className={styles.title}>Mutual Fund Scoring</h1>
          <p className={styles.subtitle}>
            {fundCount ? `${fundCount.toLocaleString('en-IN')} funds` : 'Loading'}
            {paramCount ? ` · ${paramCount} parameters` : null}
          </p>
        </div>
      </div>

      <div className={styles.meta}>
        {isFixture ? (
          <Badge tone="warn" title="One or both feeds are reading a local snapshot, not the live API">
            Snapshot data
          </Badge>
        ) : null}

        {serverError ? (
          <Badge tone="danger" title={serverError}>
            <AlertIcon width={13} height={13} />
            Last refresh failed
          </Badge>
        ) : null}

        <div className={styles.timestamps}>
          <span className={styles.timestamp} title={formatDateTime(lastUpdated)}>
            <span className={styles.pulse} aria-hidden="true" />
            <span className={styles.timestampLabel}>Updated</span>
            <strong>{lastUpdated ? formatRelative(lastUpdated) : '—'}</strong>
          </span>
          <span className={styles.sep} aria-hidden="true" />
          <span className={styles.timestamp} title={formatDateTime(nextRefreshAt)}>
            <ClockIcon width={13} height={13} className={styles.clockIcon} />
            <span className={styles.timestampLabel}>Next</span>
            <strong>{nextRefreshAt ? formatRelative(nextRefreshAt) : '—'}</strong>
          </span>
        </div>
      </div>

      {/* A sibling of .meta, not a child: the grid keeps these buttons beside the
          title on narrow screens while the timestamps drop to their own row. */}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={onRefresh}
          disabled={isRefreshing}
          title="Refresh now"
        >
          {isRefreshing ? (
            <Spinner label="Refreshing" />
          ) : (
            <RefreshIcon width={16} height={16} className={styles.refreshIcon} />
          )}
          <span className={styles.refreshLabel}>Refresh</span>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onCycleTheme}
          title={THEME_LABELS[theme]}
          aria-label={THEME_LABELS[theme]}
        >
          <ThemeIcon width={17} height={17} />
        </button>
      </div>
    </header>
  )
}
