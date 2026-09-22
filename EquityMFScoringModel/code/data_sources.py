"""
Fetches the two upstream feeds the scoring model needs and returns them in the
exact shape score_intersection_funds.load_json() produces -- {"data": [...]} --
so build_intersection_universe() is indifferent to whether the rows arrived over
the network or came out of the local snapshots in data/.

This is the ONLY module in the backend that issues HTTP requests directly --
nav_history.py's per-scheme historical-NAV calls reuse http_get()/_redact()
from here rather than duplicating the retry/redaction logic.

Configuration (EquityMFScoringModel/.env, gitignored):

    SCHEME_MASTER=<full request URL for the scheme-master feed>
    RISK=<full request URL for the risk-metrics feed>

Leaving either variable unset makes that feed fall back to its local JSON
snapshot, so the entire backend runs and can be exercised with no network access.
That is a permanent supported mode, not a stopgap.

Optional tuning:
    API_TIMEOUT_SECONDS  per-request timeout, seconds                     (default 60)
    API_VERIFY_SSL       set false only for an internal endpoint behind a
                         private CA                                       (default true)
    API_MIN_ROWS         reject a response with fewer rows than this       (default 100)

SECRET HYGIENE -- the endpoint URLs are treated as credentials. requests embeds
the full request URL in its exception messages, and error text raised from here
ends up in cache_store's `last_error`, which is served over HTTP to a browser.
So every message leaving this module passes through _redact() first, exception
chaining is suppressed (`from None`) so no inner traceback can carry a URL, and
nothing here logs a URL at any level.
"""

import json
import logging
import os
import re
import time
import warnings
from pathlib import Path
from urllib.parse import urlsplit

import requests
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent.parent
DATA_DIR = BASE_DIR / "data"

load_dotenv(BASE_DIR / ".env")

log = logging.getLogger(__name__)

SCHEME_MASTER_ENV = "SCHEME_MASTER"
RISK_ENV = "RISK"
HISTORICAL_NAV_ENV = "HISTORICAL_NAV_URL"

MASTER_FIXTURE = "scheme_masters_1.json"
RISK_FIXTURE = "risk.json"

# Columns build_intersection_universe() indexes directly. Checking them here
# turns an upstream rename into one clear error instead of a bare KeyError from
# somewhere inside pandas.
MASTER_REQUIRED = ("mf_schcode", "sch_name", "Category", "MainCategory", "FundManager",
                   "BenchmarkName", "SchemeAUM", "ExitLoad", "3YEAR", "5YEAR", "InvestmentType1")
RISK_REQUIRED = ("MF_SCHCODE", "ALPHA", "BETA", "SD", "SHARPE", "Sortino")

# 3 attempts total: immediate, +2s, +6s
RETRY_BACKOFF_SECONDS = (2, 6)

# keys an upstream JSON envelope might hide the row array under, in priority
# order -- "data" is the shape both known snapshots use
ROW_LIST_KEYS = ("data", "Data", "result", "results", "records", "rows")


class DataSourceError(RuntimeError):
    """A failure fetching, parsing or validating an upstream feed. Messages are
    always redacted, so they are safe to log and to return over HTTP."""


_URL_RE = re.compile(
    r"""(?xi)
      https?://\S+                                                   # explicit scheme
    | \b[\w.-]+\.(?:com|net|org|in|io|co|dev|gov|internal|local)\b\S*  # bare host[/path]
    | \b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\S*                          # bare ipv4[:port][/path]
    """
)

# requests phrases connection failures as "Max retries exceeded with url: /path?query"
# -- the host is elsewhere in the message, so the pattern above misses this half.
_URL_FIELD_RE = re.compile(r"\b(url:\s*)(\S+)", re.I)

# Shortest fragment worth substring-redacting. Below this, a "secret" is likely a
# value like "1" or "true" whose removal would just mangle unrelated text.
_MIN_SECRET_LEN = 8

MAX_ERROR_CHARS = 400


def _secret_fragments():
    """Every fragment of the configured endpoints that must not appear in an
    error message: the full URL, its host, path, query string, and any
    sufficiently long path segment or query value.

    Redacting the *known literal values* is what makes this airtight -- pattern
    matching alone can't anticipate every way a library might reformat a URL
    (requests, for one, splits the host and the path across two clauses of the
    same message). Longest first, so the full URL is removed before its parts."""
    fragments = set()
    for env_name in (SCHEME_MASTER_ENV, RISK_ENV, HISTORICAL_NAV_ENV):
        raw = (os.getenv(env_name) or "").strip().strip('"').strip("'")
        if not raw:
            continue
        fragments.add(raw)
        parts = urlsplit(raw)
        for candidate in (parts.netloc, parts.hostname, parts.path, parts.query,
                          f"{parts.path}?{parts.query}" if parts.query else ""):
            if candidate and len(candidate) >= 2:
                fragments.add(candidate)
        for segment in parts.path.split("/"):
            if len(segment) >= _MIN_SECRET_LEN:
                fragments.add(segment)
        for pair in parts.query.split("&"):
            _, _, value = pair.partition("=")
            if len(value) >= _MIN_SECRET_LEN:  # the usual home of an API key
                fragments.add(value)
    return sorted(fragments, key=len, reverse=True)


def _redact(text):
    """Make a message safe to log and to serve over HTTP.

    The endpoint URLs are credentials, and this text ends up in cache_store's
    `last_error`, which the dashboard displays -- so it runs on every error path.
    Three layers: exact fragments of the configured URLs, requests' "with url:"
    clause, then a generic URL-shaped pattern as a backstop."""
    text = str(text)
    for fragment in _secret_fragments():
        text = text.replace(fragment, "[redacted]")
    text = _URL_FIELD_RE.sub(r"\1[redacted]", text)
    text = _URL_RE.sub("[redacted-url]", text)
    if len(text) > MAX_ERROR_CHARS:
        text = text[:MAX_ERROR_CHARS].rstrip() + " ..."
    return text


def _env_bool(name, default):
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _env_number(name, default, cast):
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return cast(raw.strip())
    except ValueError:
        log.warning("%s=%r is not a valid number -- using %s", name, raw, default)
        return default


def parse_json(text):
    """Mirrors score_intersection_funds.load_json(): the local snapshots need the
    strict=False retry because the payload carries raw control characters, so a
    live response from the same system almost certainly does too."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(text, strict=False)


def extract_rows(payload, label):
    """Pull the row array out of whatever envelope the response uses. The known
    shape is {"success":..., "data": [...], "message":...}; a bare top-level
    array and a few other common envelope keys are accepted too."""
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        raise DataSourceError(f"{label}: expected a JSON object or array, got {type(payload).__name__}")

    if payload.get("success") is False:
        detail = _redact(payload.get("message") or "no message given")
        raise DataSourceError(f"{label}: upstream responded success=false ({detail})")

    for key in ROW_LIST_KEYS:
        value = payload.get(key)
        if isinstance(value, list):
            return value
        if isinstance(value, dict):  # e.g. {"result": {"data": [...]}}
            for nested_key in ROW_LIST_KEYS:
                if isinstance(value.get(nested_key), list):
                    return value[nested_key]

    raise DataSourceError(
        f"{label}: no row array found in the response (top-level keys: {sorted(map(str, payload))[:12]})"
    )


def _validate(rows, required_columns, label):
    if not rows:
        raise DataSourceError(f"{label}: row array is empty")
    first = rows[0]
    if not isinstance(first, dict):
        raise DataSourceError(f"{label}: rows are {type(first).__name__}, expected JSON objects")

    missing = [c for c in required_columns if c not in first]
    if missing:
        raise DataSourceError(f"{label}: response is missing required columns {missing}")

    min_rows = _env_number("API_MIN_ROWS", 100, int)
    if len(rows) < min_rows:
        # Category peer averages are computed across the whole universe, so a
        # truncated feed doesn't just hide funds -- it silently shifts the
        # scores of every fund that survives. Fail loudly instead.
        raise DataSourceError(
            f"{label}: only {len(rows)} rows, below API_MIN_ROWS={min_rows} -- refusing to score a "
            "truncated universe (paginated or filtered endpoint?)"
        )


def _silence_insecure_request_warning():
    """urllib3's InsecureRequestWarning names the target host, and it is emitted
    through the warnings module -- bypassing _redact entirely. Suppress it when
    TLS verification is deliberately off, so the host can't leak into the logs
    that way. The one-off log line below is the reminder it replaces."""
    try:
        from urllib3.exceptions import InsecureRequestWarning
    except ImportError:  # pragma: no cover - urllib3 ships with requests
        return
    warnings.filterwarnings("ignore", category=InsecureRequestWarning)


def http_get(url, label):
    timeout = _env_number("API_TIMEOUT_SECONDS", 60.0, float)
    verify = _env_bool("API_VERIFY_SSL", True)
    if not verify:
        _silence_insecure_request_warning()
        log.warning("%s: API_VERIFY_SSL is off -- TLS certificates are NOT being verified", label)
    attempts = len(RETRY_BACKOFF_SECONDS) + 1

    for attempt in range(1, attempts + 1):
        try:
            response = requests.get(url, timeout=timeout, verify=verify)
        except requests.RequestException as exc:
            reason = f"{type(exc).__name__}: {_redact(exc)}"
        else:
            if response.status_code < 400:
                return response.text
            reason = f"HTTP {response.status_code}"
            if response.status_code < 500:
                # 4xx won't fix itself: bad path, expired token, wrong params
                raise DataSourceError(f"{label}: {reason}") from None

        if attempt == attempts:
            raise DataSourceError(f"{label}: {reason} (after {attempts} attempts)") from None

        delay = RETRY_BACKOFF_SECONDS[attempt - 1]
        log.warning("%s: %s -- attempt %s/%s, retrying in %ss", label, reason, attempt, attempts, delay)
        time.sleep(delay)


def _fetch(env_name, fixture_name, required_columns):
    url = (os.getenv(env_name) or "").strip().strip('"').strip("'")

    if url:
        label = env_name
        log.info("%s: fetching live feed", label)
        text = http_get(url, label)
    else:
        label = f"{env_name} (local fixture)"
        log.info("%s is unset -- reading local snapshot %s", env_name, fixture_name)
        try:
            text = (DATA_DIR / fixture_name).read_text(encoding="utf-8")
        except OSError as exc:
            raise DataSourceError(f"{label}: cannot read {fixture_name} ({type(exc).__name__})") from None

    try:
        payload = parse_json(text)
    except json.JSONDecodeError as exc:
        raise DataSourceError(
            f"{label}: response is not valid JSON ({exc.msg} at line {exc.lineno} col {exc.colno})"
        ) from None

    rows = extract_rows(payload, label)
    _validate(rows, required_columns, label)
    log.info("%s: %s rows received", label, len(rows))
    return {"data": rows}


def fetch_scheme_masters():
    """{"data": [...]} in scheme_masters_1.json's shape."""
    return _fetch(SCHEME_MASTER_ENV, MASTER_FIXTURE, MASTER_REQUIRED)


def fetch_risk_data():
    """{"data": [...]} in risk.json's shape."""
    return _fetch(RISK_ENV, RISK_FIXTURE, RISK_REQUIRED)


def source_mode():
    """Whether each feed is live or fixture-backed -- surfaced on /api/status so
    it's obvious at a glance whether the server is serving real data. Reports
    only "live"/"fixture", never the URL itself."""
    return {
        "scheme_master": "live" if os.getenv(SCHEME_MASTER_ENV) else "fixture",
        "risk": "live" if os.getenv(RISK_ENV) else "fixture",
    }


def historical_nav_base_url():
    """The configured Historical NAV base URL, or None. There is no local-fixture
    fallback for this one (no historical NAV series is stored in data/), so
    callers must treat None as "feature unavailable", not "use the fixture"."""
    return (os.getenv(HISTORICAL_NAV_ENV) or "").strip().strip('"').strip("'") or None
