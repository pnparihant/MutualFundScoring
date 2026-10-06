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

URL shape (verified against the live endpoint):
    .../HistoricalNAV/{SchCode}/{Period}/{PeriodCnt1}/{SDate}/{EDate}/{mf_cocode}
    .../HistoricalNAV/41820/M/1/-/-/-        1 month of scheme 41820
    .../HistoricalNAV/41820/M/3/-/-/20327    3 months; the company code is optional

The scheme code is the FIRST segment and the AMC company code the LAST (and
optional -- "-" returns the same series). Getting this backwards is not an
error: the endpoint happily returns whichever scheme the first segment names.
A version that hardcoded "1" there priced every fund as scheme 1, so all of
them showed the same return.

Period="M" counts back PeriodCnt1 whole months from today (M/1 -> the last
~20 trading days, M/60 -> five years). A scheme with no NAV inside that window
-- a closed or matured fund whose last NAV is months old -- gets "No data
Available", which surfaces as a null return, not an error. That is the only
form used. Period="D" misbehaves for large counts (D/200 returned ~19 days),
and the explicit SDate/EDate forms tried returned "No data Available", so a
custom date range is served by requesting enough whole months to reach the
start date and trimming the series to [start, end] here.
"""

import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime

from data_sources import (
    DataSourceError,
    _redact,
    extract_rows,
    historical_nav_base_url,
    http_get,
    parse_json,
)

log = logging.getLogger(__name__)


def _months_to_cover(start_date):
    """Whole months back from today that reach start_date. One extra month of
    margin, since calendar months vary in length and a first row clipped off
    the start would skew the return; the series is trimmed to the exact dates
    afterwards anyway."""
    days = max((date.today() - start_date).days, 0)
    return max(1, math.ceil(days / 30.4375) + 1)


def _historical_nav_url(mf_cocode, schcode, months, start_date):
    base = historical_nav_base_url()
    if not base:
        raise DataSourceError("HISTORICAL_NAV_URL is not configured")

    period_cnt = int(months) if months else _months_to_cover(start_date)
    cocode = int(mf_cocode) if mf_cocode not in (None, "") else "-"
    return f"{base.rstrip('/')}/{int(schcode)}/M/{period_cnt}/-/-/{cocode}"


def _row_date(row):
    raw = row.get("NAVDATE") or row.get("navdate")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", ""))
    except ValueError:
        return None


def fetch_scheme_nav_history(schcode, mf_cocode, months, start_date, end_date):
    """The raw NAV rows for one scheme covering the requested window, sorted
    oldest first. With `months` (a preset) the window is exactly what the
    endpoint returns for that many months. Without it (a custom range) the
    series is trimmed to start_date..end_date, so the return is measured
    between the first NAV on/after the start and the last NAV on/before the
    end. Each row is the upstream's own dict -- at least NAVDATE and
    NAVRS/ADJNAVRS are expected.

    Raises DataSourceError on a configuration problem or an HTTP failure --
    callers doing a bulk fetch must catch that per-scheme so one bad scheme
    can't sink the whole batch (see point_to_point_returns_bulk)."""
    url = _historical_nav_url(mf_cocode, schcode, months, start_date)
    label = f"HistoricalNAV(schcode={schcode})"
    text = http_get(url, label)
    payload = parse_json(text)
    rows = extract_rows(payload, label)

    dated = [(d, row) for row in rows if (d := _row_date(row)) is not None]
    if not months:
        dated = [(d, row) for d, row in dated if start_date <= d.date() <= end_date]
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


_MISS = object()
_CACHE_TTL_SECONDS = 30 * 60
_CACHE_MAX_ENTRIES = 20_000
_cache = {}
_cache_lock = threading.Lock()


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
    if hit is not None and time.monotonic() - hit[0] < _CACHE_TTL_SECONDS:
        return hit[1]
    return _MISS


def _cache_put(key, value):
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX_ENTRIES:
            _cache.clear()
        _cache[key] = (time.monotonic(), value)


def _one(schcode, mf_cocode, months, start_date, end_date):
    # NAVs are end-of-day, so a result stays valid for the session -- caching
    # makes re-selecting a range (or paging back to it) instant instead of
    # another round of slow upstream calls. Only successful fetches are cached:
    # a transient failure must not stick as "no return" for half an hour.
    key = (schcode, months, None if months else start_date, None if months else end_date,
           date.today())
    cached = _cache_get(key)
    if cached is not _MISS:
        return cached
    try:
        rows = fetch_scheme_nav_history(schcode, mf_cocode, months, start_date, end_date)
    except Exception as exc:  # noqa: BLE001 -- one scheme's failure must not sink the batch
        log.warning("point-to-point return failed for schcode=%s: %s",
                     schcode, _redact(f"{type(exc).__name__}: {exc}"))
        return None
    result = point_to_point_return(rows)
    _cache_put(key, result)
    return result


def point_to_point_returns_bulk(funds, months, start_date, end_date, max_workers=12):
    """funds: iterable of (schcode, mf_cocode) pairs. `months` is the whole
    number of months for a preset request, or None for a custom
    start_date/end_date range (fetched as enough whole months to cover the
    start, then trimmed to the dates -- see the module docstring). Returns
    {schcode: point_to_point_return()'s dict,
    or None}. Fetched in parallel (one HTTP call per scheme, bounded by
    max_workers) since the dashboard may ask for the currently filtered set,
    which could be hundreds of funds."""
    funds = list(funds)
    if not funds:
        return {}
    results = {}
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_to_schcode = {
            pool.submit(_one, schcode, mf_cocode, months, start_date, end_date): schcode
            for schcode, mf_cocode in funds
        }
        for future in as_completed(future_to_schcode):
            schcode = future_to_schcode[future]
            results[schcode] = future.result()
    return results
