# Equity MF Scoring API -- FastAPI + APScheduler.
#
# Contains the complete Python runtime and every dependency, so nothing needs to
# be installed on the host beyond Docker itself.
#
# Build context is EquityMFScoringModel/ (see docker-compose.yml), which gives
# the image both code/ and the data/ snapshots the fixture fallback needs.

FROM python:3.13-slim

# Asia/Kolkata is mandatory: the daily refresh is a cron trigger at 06:30 IST.
# scheduler.py resolves it via Python's zoneinfo, which reads the `tzdata`
# PyPI package (see requirements.txt) as a fallback when the OS has no
# zoneinfo database -- deliberately no `apt-get install tzdata`, so the build
# doesn't need a Debian package mirror reachable at all.
ENV TZ=Asia/Kolkata \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first: this layer is cached and only rebuilds when
# requirements.txt changes, not on every application code edit.
COPY code/requirements.txt ./code/requirements.txt
RUN pip install --no-cache-dir -r code/requirements.txt

COPY code/ ./code/
COPY data/ ./data/

# cache_store resolves CACHE_DIR as <parent of code/>/cache -- i.e. /app/cache.
# Created here and owned by the app user so the container can write its disk
# mirror even when the volume is mounted fresh.
RUN mkdir -p /app/cache \
 && useradd --create-home --shell /usr/sbin/nologin appuser \
 && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# /api/health is served from memory and answers immediately, so it stays green
# while the first fetch-and-score runs in the background. start-period covers
# interpreter start and the disk-cache load, not the refresh. Uses Python's
# own urllib rather than curl -- Python is already here, curl would need
# another apt-get install.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

# Single worker deliberately: the cache is per-process in-memory state and the
# scheduler must not run in more than one process, or the daily refresh would
# fire once per worker.
CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "code", "--workers", "1"]
