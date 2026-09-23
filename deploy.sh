#!/usr/bin/env bash
# Safe UAT redeploy: build first, recreate only after a successful build, and
# verify the new container is actually healthy before declaring success.
#
# WHY THIS EXISTS: `docker compose build` never touches a running container,
# and `docker compose up -d` only replaces a service's container once its new
# image already exists -- so a failed build on its own leaves whatever is
# currently running untouched. The thing that actually causes downtime is
# running `docker compose down` (or `docker-compose down`) before rebuilding:
# that stops and removes the containers immediately, before the new image
# even starts building, so a build failure after that point leaves nothing
# running at all. This script never calls `down`, on purpose.
#
# Usage: ./deploy.sh   (run from the repo root, next to docker-compose.yml)

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# Works with either the `docker compose` plugin or the older `docker-compose`
# binary -- whichever this host actually has installed.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

echo "==> Building images (currently running containers are not touched by this step)"
"${COMPOSE[@]}" build

echo "==> Recreating only the services whose image changed"
"${COMPOSE[@]}" up -d

echo "==> Waiting for the API to report healthy..."
healthy=false
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' equity-mf-scoring-api 2>/dev/null || echo "starting")
  if [ "$status" = "healthy" ]; then
    healthy=true
    break
  fi
  sleep 2
done

if [ "$healthy" != "true" ]; then
  echo "API did not become healthy within 60s -- check: docker logs equity-mf-scoring-api" >&2
  exit 1
fi

echo "==> API healthy. Forcing a data refresh so it picks up the new scoring logic"
echo "    immediately instead of waiting for the next 06:30 IST cron run:"
echo "    curl -X POST \$API_PUBLIC_URL/api/refresh -H \"X-Refresh-Token: \$REFRESH_TOKEN\""
echo "==> Deploy complete."
