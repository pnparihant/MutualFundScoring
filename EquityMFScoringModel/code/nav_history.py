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

URL shape (confirmed from two real examples):
    .../HistoricalNAV/{MF_COCODE}/{Period}/{PeriodCnt1}/{SDate}/{EDate}/{SchCode}
    .../HistoricalNAV/1/M/1/-/-/5946    (1 month, scheme 5946)
    .../HistoricalNAV/1/M/10/-/-/-      (10 months)

Both confirmed examples vary Period/PeriodCnt1 and leave SDate/EDate as "-" --
so that's what this module does too: a whole-months request sends
Period="M", PeriodCnt1=<months>. SDate/EDate are never populated; no example
of them actually being used has been seen, so building a request around them
(as an earlier version of this module did) was unverified guesswork and is
no longer how this works.

STILL UNVERIFIED (no network path to cmotsnew.arihantcapital.com from this
environment, so these remain best guesses until tested live):
    - Period="D" for an arbitrary (non-whole-month) custom date range, sending
      PeriodCnt1 as a day count -- inferred from the M=month code existing,
      not from a confirmed example. If wrong, _period_for_range() is the one
      place to fix.
    - whether the path's MF_COCODE segment must be the scheme's real AMC
      company code (currently sent as the scheme's own mf_cocode) or is a
      free/ignored positional value.
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


def _period_for_range(months, start_date, end_date):
    """(period_code, period_cnt) for the URL. Prefers the confirmed Period="M"
    form when the request is a whole number of months (the dashboard's preset
    buttons always are); falls back to a day count for an arbitrary custom
    range -- see the module docstring's STILL UNVERIFIED note on that path."""
    if months:
        return "M", int(months)
    days = (end_date - start_date).days
    return "D", max(days, 1)


def _historical_nav_url(mf_cocode, schcode, months, start_date, end_date):
    base = historical_nav_base_url()
    if not base:
        raise DataSourceError("HISTORICAL_NAV_URL is not configured")
    cocode = int(mf_cocode) if mf_cocode not in (None, "") else "-"
    period, period_cnt = _period_for_range(months, start_date, end_date)
    return f"{base.rstrip('/')}/{cocode}/{period}/{period_cnt}/-/-/{int(schcode)}"


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
    oldest first. `months` takes priority (Period="M") when given; otherwise
    the window is derived from start_date/end_date as a day count (see
    _period_for_range). Each row is the upstream's own dict -- at least
    NAVDATE and NAVRS/ADJNAVRS are expected.

    Raises DataSourceError on a configuration problem or an HTTP failure --
    callers doing a bulk fetch must catch that per-scheme so one bad scheme
    can't sink the whole batch (see point_to_point_returns_bulk)."""
    url = _historical_nav_url(mf_cocode, schcode, months, start_date, end_date)
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


def _one(schcode, mf_cocode, months, start_date, end_date):
    try:
        rows = fetch_scheme_nav_history(schcode, mf_cocode, months, start_date, end_date)
    except Exception as exc:  # noqa: BLE001 -- one scheme's failure must not sink the batch
        log.warning("point-to-point return failed for schcode=%s: %s",
                     schcode, _redact(f"{type(exc).__name__}: {exc}"))
        return None
    return point_to_point_return(rows)


def point_to_point_returns_bulk(funds, months, start_date, end_date, max_workers=12):
    """funds: iterable of (schcode, mf_cocode) pairs. `months` is the whole
    number of months for a preset request (Period="M"), or None for a custom
    start_date/end_date range (falls back to a day count, Period="D" -- see
    the module docstring). Returns {schcode: point_to_point_return()'s dict,
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
