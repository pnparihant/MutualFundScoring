"""
FastAPI service exposing the scored mutual fund universe (Equity, Debt, Hybrid,
Other and Solution-Oriented -- Regular plans only) to the dashboard.

    GET  /api/funds    the whole scored universe + the metadata to render it
    GET  /api/status   cache/scheduler health, for ops and manual curl checks
    POST /api/refresh  force a refresh now (also the seam an external scheduler
                       would call if this ever moves to serverless hosting)
    GET  /api/health   liveness probe

Every response is served from cache_store's in-memory snapshot, so no request
ever waits on the upstream feeds. See cache_store for the fail-safe semantics and
scheduler for the daily refresh.

Configuration (EquityMFScoringModel/.env, gitignored -- see .env.example):

    APP_ENV              development | production            (default development)
    EXTRA_CORS_ORIGINS   comma-separated browser origins allowed to call this API
    REFRESH_TOKEN        shared secret for POST /api/refresh

Setting APP_ENV=production tightens two things that are only safe on a private
machine: the localhost CORS origins are dropped, and POST /api/refresh refuses
to serve without REFRESH_TOKEN configured instead of running unauthenticated.

Run locally:
    uvicorn api:app --reload --port 8000 --app-dir EquityMFScoringModel/code
"""

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

import nav_history
import scheduler
from cache_store import get_rows, get_status, load_cache_from_disk, refresh_cache
from data_sources import historical_nav_base_url
from score_intersection_funds_13param import PARAM_CATEGORY, PARAM_LABELS, RATING_BANDS, WEIGHTS

# One HTTP call to the upstream Historical NAV endpoint per scheme -- past
# this many schemes in one request, ask the caller to narrow their filters
# first rather than let the batch balloon into thousands of live calls.
MAX_POINT_TO_POINT_SCHEMES = 1500

log = logging.getLogger(__name__)

DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


def _is_production():
    """APP_ENV gates the two things that are safe locally but not on a public
    URL: the localhost CORS origins, and an unauthenticated POST /api/refresh."""
    return (os.getenv("APP_ENV") or "development").strip().lower() == "production"


@asynccontextmanager
async def lifespan(_app):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_cache_from_disk()   # serve last-good data immediately, before any fetch
    scheduler.start()        # cron job + startup catch-up if that data is stale
    try:
        yield
    finally:
        scheduler.shutdown()


app = FastAPI(
    title="Mutual Fund Scoring API",
    version="1.0.0",
    description="Daily-refreshed mutual fund scores (all categories, Regular plans), "
                 "built from the 14-parameter scoring matrix.",
    lifespan=lifespan,
)

# The full universe with per-fund metrics is a few MB of very repetitive JSON --
# gzip takes it to a fraction of that for a table the browser loads once a day.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# CORS rather than a Vite dev proxy, so the same build works whether or not the
# frontend ends up on the same origin once hosting is decided. Deployed origins
# come from EXTRA_CORS_ORIGINS; the localhost pair is dropped in production so a
# public instance doesn't advertise a dev setup it can't actually serve.
_extra_origins = [o.strip() for o in (os.getenv("EXTRA_CORS_ORIGINS") or "").split(",") if o.strip()]
_allowed_origins = _extra_origins if _is_production() else DEV_ORIGINS + _extra_origins
if not _allowed_origins:
    log.warning("no CORS origins configured -- set EXTRA_CORS_ORIGINS to the dashboard's URL")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _columns():
    """The 13 scored parameters as display metadata, derived from the scoring
    module's own PARAM_LABELS / PARAM_CATEGORY / WEIGHTS -- so the frontend never
    keeps a second copy of the labels, groupings or weights that could drift out
    of sync with the model."""
    total = sum(WEIGHTS.values())
    return [
        {
            "key": key,
            "label": PARAM_LABELS[key],
            "group": PARAM_CATEGORY[key],
            "weight": round(WEIGHTS[key] / total, 4),
        }
        for key in WEIGHTS
    ]


def _groups():
    """Distinct parameter groups in matrix order (Return, Risk, Cost & Operational),
    for the table's grouped header row."""
    seen = []
    for key in WEIGHTS:
        group = PARAM_CATEGORY[key]
        if group not in seen:
            seen.append(group)
    return seen


def _ratings():
    """The composite-score -> rating/recommendation legend, so the dashboard can
    label and colour-code scores using the matrix's own bands."""
    return [
        {"min_composite": cutoff, "rating": rating, "recommendation": recommendation}
        for cutoff, rating, recommendation in RATING_BANDS
    ]


@app.get("/api/funds")
def get_funds():
    """The whole scored universe plus the metadata needed to render it.

    `next_refresh_at` is the contract the dashboard's refetch logic runs on: it
    lets the browser decide locally whether new data can possibly exist yet, and
    skip the request entirely when it can't.
    """
    status = get_status()
    rows = get_rows()
    return {
        "count": len(rows),
        "data": rows,
        "columns": _columns(),
        "groups": _groups(),
        "ratings": _ratings(),
        "last_updated": status["last_updated"],
        "next_refresh_at": scheduler.next_run_time(),
        "last_error": status["last_error"],
        "source_mode": status["source_mode"],
    }


@app.get("/api/status")
def get_service_status():
    """Cache and scheduler health. Cheap enough to poll, though the dashboard
    doesn't -- it's here for ops checks and debugging."""
    return {**get_status(), "next_refresh_at": scheduler.next_run_time()}


@app.post("/api/refresh")
def post_refresh(x_refresh_token: str | None = Header(default=None)):
    """Force a refresh synchronously and return the resulting status.

    Protected by the REFRESH_TOKEN shared secret. That token is optional in
    development, where an open endpoint is a convenience; in production it is
    mandatory, because an unauthenticated refresh is an open trigger for a full
    upstream fetch-and-score on a public URL. Missing it there disables the
    endpoint rather than leaving it open.
    """
    expected = (os.getenv("REFRESH_TOKEN") or "").strip()
    if not expected:
        if _is_production():
            log.error("POST /api/refresh refused: REFRESH_TOKEN is not set")
            raise HTTPException(status_code=503, detail="refresh endpoint is not configured")
    elif x_refresh_token != expected:
        raise HTTPException(status_code=401, detail="missing or invalid X-Refresh-Token")
    result = refresh_cache("manual")
    return {**result, "next_refresh_at": scheduler.next_run_time()}


class PointToPointRequest(BaseModel):
    schcodes: list[int]
    start_date: str  # YYYY-MM-DD
    end_date: str     # YYYY-MM-DD


@app.post("/api/returns/point-to-point")
def post_point_to_point_returns(body: PointToPointRequest):
    """On-demand date-wise return for a set of schemes -- NOT served from the
    daily cache, since the date range is chosen live by the dashboard user.
    One upstream HTTP call per scheme (see nav_history.py), fetched in
    parallel; a scheme that fails or has no data in range comes back `null`
    rather than failing the whole request.
    """
    if not historical_nav_base_url():
        raise HTTPException(
            status_code=503,
            detail="point-to-point returns are not configured (HISTORICAL_NAV_URL unset)",
        )
    if not body.schcodes:
        raise HTTPException(status_code=400, detail="schcodes must not be empty")
    if len(body.schcodes) > MAX_POINT_TO_POINT_SCHEMES:
        raise HTTPException(
            status_code=400,
            detail=f"too many schemes ({len(body.schcodes)}) -- narrow your filters to "
                   f"{MAX_POINT_TO_POINT_SCHEMES} or fewer and try again",
        )
    try:
        start = datetime.strptime(body.start_date, "%Y-%m-%d").date()
        end = datetime.strptime(body.end_date, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="start_date/end_date must be YYYY-MM-DD") from None
    if start >= end:
        raise HTTPException(status_code=400, detail="start_date must be before end_date")

    by_schcode = {row["schcode"]: row for row in get_rows()}
    wanted = []
    results = {}
    for schcode in body.schcodes:
        row = by_schcode.get(schcode)
        if row is None:
            results[schcode] = None
            continue
        wanted.append((schcode, row.get("mf_cocode")))

    results.update(nav_history.point_to_point_returns_bulk(wanted, start, end))
    return {"returns": {str(schcode): value for schcode, value in results.items()}}


@app.get("/api/health")
def get_health():
    return {"status": "ok"}


@app.get("/")
def get_root():
    return {
        "service": "Mutual Fund Scoring API",
        "endpoints": ["/api/funds", "/api/status", "/api/refresh", "/api/health",
                      "/api/returns/point-to-point", "/docs"],
    }
