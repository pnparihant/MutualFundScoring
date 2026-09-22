"""
The served copy of the scored fund universe: an in-memory snapshot, mirrored to
disk, refreshed by scheduler.py once a day.

Two properties everything else depends on:

1. `GET /api/funds` reads memory only. An HTTP request never waits on the
   upstream feeds, so the dashboard responds in milliseconds regardless of how
   slow or unavailable the upstream API is.
2. A failed refresh is non-destructive. Fetch errors, malformed payloads and
   scoring bugs all leave the previously-cached rows and their `last_updated`
   exactly as they were, and only set `last_error`. The dashboard degrades to
   "stale but valid, with a visible warning" -- never to blank or HTTP 500.

The disk mirror (cache/dashboard_cache.json) exists so a restart serves the last
good data immediately instead of an empty table while the first fetch runs. It is
deliberately separate from output/, which remains the manual CLI export target.
"""

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from data_sources import _redact, fetch_risk_data, fetch_scheme_masters, source_mode
from score_intersection_funds_13param import (
    build_dataset_records,
    build_intersection_universe,
    build_score_rows,
    clean,
)

BASE_DIR = Path(__file__).parent.parent
CACHE_DIR = BASE_DIR / "cache"
CACHE_FILE = CACHE_DIR / "dashboard_cache.json"

log = logging.getLogger(__name__)

_state = {
    "rows": [],
    "last_updated": None,      # ISO 8601 UTC of the last SUCCESSFUL refresh
    "last_attempt": None,      # ISO 8601 UTC of the last attempt, success or not
    "last_error": None,        # redacted message from the last failed attempt
    "last_duration_seconds": None,
    "row_counts": None,        # upstream rows received, for diagnostics
    "source_mode": None,       # {"scheme_master": "live"|"fixture", ...}
    "refresh_in_progress": False,
}

_lock = threading.Lock()          # guards every read/write of _state
_refresh_lock = threading.Lock()  # acquired non-blocking: serialises refreshes


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _jsonable(value):
    """Convert pandas/numpy scalars into plain Python and NaN/NaT/inf into None.

    Necessary because the score rows come out of DataFrame.iterrows(), so a
    scheme code is a numpy.int64 -- which json.dumps and FastAPI's encoder both
    refuse. Normalising once, here, means the cache only ever holds JSON-safe
    values and both the disk mirror and the HTTP response serialise trivially.
    (The CLI sidesteps this with json.dumps(default=str), which stringifies
    those codes instead -- not what an API should return.)"""
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, bool)):
        return value

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):  # includes numpy.float64
        return None if (value != value or value in (float("inf"), float("-inf"))) else float(value)

    item = getattr(value, "item", None)  # numpy scalars: int64, bool_, ...
    if callable(item):
        try:
            return _jsonable(item())
        except (TypeError, ValueError):
            pass
    return str(value)  # dates, Decimals, anything else exotic


def _set(**changes):
    with _lock:
        _state.update(changes)


def get_status():
    """Everything about the cache except the rows themselves."""
    with _lock:
        return {
            "last_updated": _state["last_updated"],
            "last_attempt": _state["last_attempt"],
            "last_error": _state["last_error"],
            "last_duration_seconds": _state["last_duration_seconds"],
            "row_counts": _state["row_counts"],
            "source_mode": _state["source_mode"] or source_mode(),
            "refresh_in_progress": _state["refresh_in_progress"],
            "fund_count": len(_state["rows"]),
        }


def get_rows():
    with _lock:
        return _state["rows"]


def is_stale(max_age_hours=24):
    """True when there is no cached data, or it predates the last scheduled
    window -- i.e. a refresh should be run now rather than waiting for cron."""
    with _lock:
        last_updated = _state["last_updated"]
        has_rows = bool(_state["rows"])
    if not last_updated or not has_rows:
        return True
    try:
        stamp = datetime.fromisoformat(last_updated)
    except ValueError:
        return True
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - stamp > timedelta(hours=max_age_hours)


# --------------------------------------------------------------------------
# disk mirror
# --------------------------------------------------------------------------

def _persist(snapshot):
    """Write via a temp file + os.replace so a crash mid-write can't leave a
    half-written cache behind -- os.replace is atomic on the same filesystem."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({**snapshot, "saved_at": _now_iso()}), encoding="utf-8")
        os.replace(tmp, CACHE_FILE)
    except (OSError, TypeError, ValueError) as exc:
        # A cache we can't write is a degraded restart, not a failed refresh --
        # the in-memory copy is already live, so don't fail the refresh over it.
        log.warning("could not write %s: %s", CACHE_FILE.name, _redact(exc))


def load_cache_from_disk():
    """Restore the last good snapshot at startup. `last_error` is deliberately
    not restored -- no attempt has been made yet in this process."""
    if not CACHE_FILE.exists():
        log.info("no cache file at %s -- starting empty", CACHE_FILE)
        return False
    try:
        snapshot = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        rows = snapshot["rows"]
        if not isinstance(rows, list):
            raise ValueError("'rows' is not a list")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.warning("ignoring unreadable cache file %s: %s", CACHE_FILE.name, _redact(exc))
        return False

    _set(
        rows=rows,
        last_updated=snapshot.get("last_updated"),
        row_counts=snapshot.get("row_counts"),
        source_mode=snapshot.get("source_mode"),
    )
    log.info("loaded %s funds from disk cache (last_updated=%s)", len(rows), snapshot.get("last_updated"))
    return True


# --------------------------------------------------------------------------
# refresh
# --------------------------------------------------------------------------

def _attach_metrics(df, rows):
    """Bolt each fund's raw metric values onto its score row as `metrics`,
    reusing the existing build_dataset_records() -- so the dashboard can show the
    actual Alpha/Sharpe/AUM/exit-load values beside their 1-5 scores without a
    second endpoint or a second pass over the frame.

    Also stamps each row with its raw `mf_cocode` (not part of `metrics` --
    it's an internal identifier, not something to display or export) so
    /api/returns/point-to-point can resolve a scheme's AMC company code
    straight from the cache instead of re-joining the source data."""
    by_code = {record["Scheme Code"]: record for record in build_dataset_records(df)}
    mf_cocode_by_schcode = df["mf_cocode"].to_dict() if "mf_cocode" in df.columns else {}
    for row in rows:
        record = by_code.get(row["schcode"])
        if record is not None:
            row["metrics"] = {k: clean(v) for k, v in record.items() if k != "Scheme Code"}
        row["mf_cocode"] = clean(mf_cocode_by_schcode.get(row["schcode"]))
    return rows


def _build_snapshot():
    """Fetch -> join -> score. Everything upstream of the cache swap."""
    master = fetch_scheme_masters()
    risk = fetch_risk_data()
    df = build_intersection_universe(master, risk)
    rows = _attach_metrics(df, build_score_rows(df))  # no top_n: the dashboard shows the whole universe
    return {
        "rows": _jsonable(rows),
        "row_counts": {"scheme_master": len(master["data"]), "risk": len(risk["data"])},
        "source_mode": source_mode(),
    }


def refresh_cache(reason="scheduled"):
    """Rebuild the cache from the upstream feeds. Never raises: a failure is
    reported through the returned status and `last_error`, leaving the previous
    rows serving. Concurrent calls (cron firing while a manual POST /api/refresh
    is mid-flight) are skipped rather than queued."""
    if not _refresh_lock.acquire(blocking=False):
        log.info("refresh (%s) skipped -- a refresh is already running", reason)
        return {**get_status(), "ok": False, "skipped": True}

    started = time.monotonic()
    _set(refresh_in_progress=True)
    try:
        snapshot = _build_snapshot()
    except Exception as exc:  # noqa: BLE001 -- a bad refresh must not take the API down
        message = _redact(f"{type(exc).__name__}: {exc}")
        elapsed = round(time.monotonic() - started, 2)
        log.error("refresh (%s) FAILED after %ss: %s", reason, elapsed, message)
        _set(last_error=message, last_attempt=_now_iso(), refresh_in_progress=False)
        return {**get_status(), "ok": False, "skipped": False}
    else:
        elapsed = round(time.monotonic() - started, 2)
        stamp = _now_iso()
        _set(
            rows=snapshot["rows"],
            row_counts=snapshot["row_counts"],
            source_mode=snapshot["source_mode"],
            last_updated=stamp,
            last_attempt=stamp,
            last_error=None,
            last_duration_seconds=elapsed,
            refresh_in_progress=False,
        )
        _persist({
            "rows": snapshot["rows"],
            "row_counts": snapshot["row_counts"],
            "source_mode": snapshot["source_mode"],
            "last_updated": stamp,
        })
        log.info("refresh (%s) ok: %s funds scored in %ss (%s)",
                 reason, len(snapshot["rows"]), elapsed, snapshot["row_counts"])
        return {**get_status(), "ok": True, "skipped": False}
    finally:
        _set(refresh_in_progress=False)
        _refresh_lock.release()
