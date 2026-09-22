"""
Per-scheme historical NAV lookups and point-to-point return calculations, used
by the dashboard's on-demand "date-wise return" feature
(POST /api/returns/point-to-point in api.py).

Unlike data_sources.py's two bulk feeds, this hits CMOTS's Historical NAV
endpoint once PER SCHEME, so it is never part of the daily cache refresh --
it's called live, for whatever schemes and date range the dashboard user has
asked about right now.

Configuration (EquityMFScoringModel/.env, gitignored):

    HISTORICAL_NAV_URL=<base request URL, up to and including .../HistoricalNAV>

Leaving it unset disables the feature outright (see
data_sources.historical_nav_base_url()) -- there is no local-fixture
fallback, because no historical NAV series is stored anywhere in data/.

UNVERIFIED against the live endpoint -- this environment has no network path
to cmotsnew.arihantcapital.com, so the following are best guesses from the one
sample URL given, not confirmed behaviour. Confirm with a real call before
relying on this in production; _historical_nav_url() is the only place that
needs to change if any guess is wrong:
    - SDate/EDate date format (currently DD-MM-YYYY, see DATE_FORMAT)
    - whether the path's MF_COCODE segment must be the scheme's real AMC
      company code (currently sent as the scheme's own mf_cocode) or is a
      free/ignored positional value
    - Period/PeriodCnt1 behaviour when SDate/EDate are given explicitly
      (currently sent as "-"/"-", mirroring the sample URL's own use of "-"
      for the half of the pair it isn't using)
"""

import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from data_sources import (
    DataSourceError,
    _redact,
    extract_rows,
    historical_nav_base_url,
    http_get,
    parse_json,
)

log = logging.getLogger(__name__)

DATE_FORMAT = "%d-%m-%Y"  # UNVERIFIED -- see module docstring


def _format_date(value):
    return value.strftime(DATE_FORMAT)


def _historical_nav_url(mf_cocode, schcode, start_date, end_date):
    base = historical_nav_base_url()
    if not base:
        raise DataSourceError("HISTORICAL_NAV_URL is not configured")
    cocode = int(mf_cocode) if mf_cocode not in (None, "") else "-"
    return (
        f"{base.rstrip('/')}/{cocode}/-/-/"
        f"{_format_date(start_date)}/{_format_date(end_date)}/{int(schcode)}"
    )


def _row_date(row):
    raw = row.get("NAVDATE") or row.get("navdate")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", ""))
    except ValueError:
        return None


def fetch_scheme_nav_history(schcode, mf_cocode, start_date, end_date):
    """The raw NAV rows for one scheme between start_date and end_date
    (inclusive), sorted oldest first. Each row is the upstream's own dict --
    at least NAVDATE and NAVRS/ADJNAVRS are expected.

    Raises DataSourceError on a configuration problem or an HTTP failure --
    callers doing a bulk fetch must catch that per-scheme so one bad scheme
    can't sink the whole batch (see point_to_point_returns_bulk)."""
    url = _historical_nav_url(mf_cocode, schcode, start_date, end_date)
    label = f"HistoricalNAV(schcode={schcode})"
    text = http_get(url, label)
    payload = parse_json(text)
    rows = extract_rows(payload, label)

    dated = [(d, row) for row in rows if (d := _row_date(row)) is not None]
    dated.sort(key=lambda pair: pair[0])
    return [row for _, row in dated]


def _nav_value(row):
    """Prefers the dividend/split-adjusted NAV (ADJNAVRS) over the raw NAV,
    since it's the more accurate total-return proxy; falls back to NAVRS if
    the adjusted figure isn't present on a row."""
    for key in ("ADJNAVRS", "AdjNavRs", "NAVRS", "NavRs"):
        value = row.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def point_to_point_return(nav_rows):
    """% change from the first to the last usable NAV row in the (already
    date-sorted) series. None if there aren't at least two usable points."""
    values = [(row, _nav_value(row)) for row in nav_rows]
    values = [(row, v) for row, v in values if v is not None and v > 0]
    if len(values) < 2:
        return None
    start_row, start_val = values[0]
    end_row, end_val = values[-1]
    return {
        "return_pct": round((end_val - start_val) / start_val * 100, 2),
        "start_date": start_row.get("NAVDATE"),
        "end_date": end_row.get("NAVDATE"),
    }


def _one(schcode, mf_cocode, start_date, end_date):
    try:
        rows = fetch_scheme_nav_history(schcode, mf_cocode, start_date, end_date)
    except Exception as exc:  # noqa: BLE001 -- one scheme's failure must not sink the batch
        log.warning("point-to-point return failed for schcode=%s: %s",
                     schcode, _redact(f"{type(exc).__name__}: {exc}"))
        return None
    return point_to_point_return(rows)


def point_to_point_returns_bulk(funds, start_date, end_date, max_workers=12):
    """funds: iterable of (schcode, mf_cocode) pairs. Returns
    {schcode: point_to_point_return()'s dict, or None}. Fetched in parallel
    (one HTTP call per scheme, bounded by max_workers) since the dashboard may
    ask for the currently filtered set, which could be hundreds of funds."""
    funds = list(funds)
    if not funds:
        return {}
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_schcode = {
            pool.submit(_one, schcode, mf_cocode, start_date, end_date): schcode
            for schcode, mf_cocode in funds
        }
        for future in as_completed(future_to_schcode):
            schcode = future_to_schcode[future]
            results[schcode] = future.result()
    return results
