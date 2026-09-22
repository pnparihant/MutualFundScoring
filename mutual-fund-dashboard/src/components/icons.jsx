/**
 * Inline SVG icons -- deliberately not an icon package. A dashboard needs a
 * dozen glyphs; a dependency for that is weight and a supply-chain surface for
 * no benefit. Each is decorative: labelling lives on the control that uses it.
 */

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

export const SearchIcon = (props) => (
  <svg {...base} {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

export const CloseIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const ChevronDownIcon = (props) => (
  <svg {...base} {...props}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const ChevronRightIcon = (props) => (
  <svg {...base} {...props}>
    <path d="m9 6 6 6-6 6" />
  </svg>
)

export const ChevronLeftIcon = (props) => (
  <svg {...base} {...props}>
    <path d="m15 6-6 6 6 6" />
  </svg>
)

export const RefreshIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

export const DownloadIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
)

export const SunIcon = (props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

export const MoonIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
)

export const MonitorIcon = (props) => (
  <svg {...base} {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8m-4-4v4" />
  </svg>
)

export const AlertIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M12 9v4m0 4h.01" />
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
)

export const ClockIcon = (props) => (
  <svg {...base} {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const FilterIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </svg>
)

export const SortIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M8 5v14m0 0-3-3m3 3 3-3" />
    <path d="M16 19V5m0 0-3 3m3-3 3 3" />
  </svg>
)

export const ArrowUpIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M12 19V5m0 0-6 6m6-6 6 6" />
  </svg>
)

export const ArrowDownIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
  </svg>
)

export const CheckIcon = (props) => (
  <svg {...base} {...props}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
)

export const ExpandIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M14 4h6v6M10 20H4v-6" />
    <path d="M20 4l-7 7M4 20l7-7" />
  </svg>
)

export const SparkIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
  </svg>
)

export const LayersIcon = (props) => (
  <svg {...base} {...props}>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
)

export const CalendarIcon = (props) => (
  <svg {...base} {...props}>
    <rect x="3" y="4" width="18" height="17" rx="2" />
    <path d="M3 9h18M8 2v4m8-4v4" />
  </svg>
)
