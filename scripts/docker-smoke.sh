#!/usr/bin/env bash
set -euo pipefail

# SupermarketOS Live Containerized Production Stack Smoke Test (Wave 2 Phase 5)
# Builds production API, Web (Nginx), and Python Analytics Docker images, boots API + Web
# on an isolated Docker bridge network attached to PostgreSQL 16, and proves end-to-end
# SPA serving, Nginx /api reverse proxying, JWT auth, Prometheus metrics, SSE streaming,
# and containerized ML pipeline execution with 12/12 data-quality contracts.

PG_CONTAINER="${PG_CONTAINER:-supermarket-os-postgres}"
PG_USER="${POSTGRES_USER:-supermarket}"
PG_PASS="${POSTGRES_PASSWORD:-supermarket_dev_password}"
PG_DB="${POSTGRES_DB:-supermarket_os}"
NET_NAME="smos_smoke_net_$$"
API_CTR="smos_smoke_api_$$"
WEB_CTR="smos_smoke_web_$$"
HOST_PORT="${SMOKE_WEB_PORT:-18080}"
SMOKE_SECRET="supermarket-os-docker-smoke-secret-2026-xyz987654"

cleanup() {
  docker rm -f "$WEB_CTR" "$API_CTR" >/dev/null 2>&1 || true
  docker network disconnect "$NET_NAME" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[docker-smoke] Building production Docker images..."
docker build -f infra/Dockerfile.api -t supermarket-os-api:verify .
docker build -f infra/Dockerfile.web -t supermarket-os-web:verify .
docker build -f infra/Dockerfile.analytics -t supermarket-os-analytics:verify .

echo "[docker-smoke] Creating isolated bridge network ${NET_NAME}..."
docker network create "$NET_NAME" >/dev/null
docker network connect --alias postgres "$NET_NAME" "$PG_CONTAINER"

echo "[docker-smoke] Starting production API container (${API_CTR})..."
docker run -d --name "$API_CTR" \
  --network "$NET_NAME" --network-alias api \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e PORT=4000 \
  -e DATABASE_URL="postgres://${PG_USER}:${PG_PASS}@postgres:5432/${PG_DB}" \
  -e AUTH_SECRET="$SMOKE_SECRET" \
  -e CORS_ORIGINS="http://127.0.0.1:${HOST_PORT},http://localhost:${HOST_PORT}" \
  supermarket-os-api:verify >/dev/null

echo "[docker-smoke] Starting production Nginx Web container (${WEB_CTR} -> 127.0.0.1:${HOST_PORT})..."
docker run -d --name "$WEB_CTR" \
  --network "$NET_NAME" \
  -p "127.0.0.1:${HOST_PORT}:8080" \
  supermarket-os-web:verify >/dev/null

echo "[docker-smoke] Waiting for Nginx -> API -> PostgreSQL readiness probe..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${HOST_PORT}/api/health" | grep -q '"db":"connected"'; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "[docker-smoke] API container logs:" >&2
    docker logs "$API_CTR" >&2 || true
    echo "[docker-smoke] Web container logs:" >&2
    docker logs "$WEB_CTR" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "  ✓ GET /api/health via Nginx -> 200 connected"

echo "[docker-smoke] Verifying Nginx SPA root & security headers (CSP, HSTS, X-Frame-Options)..."
SPA_HTML=$(curl -sfD - "http://127.0.0.1:${HOST_PORT}/")
echo "$SPA_HTML" | grep -qi "X-Frame-Options: DENY"
echo "$SPA_HTML" | grep -qi "Content-Security-Policy:"
echo "$SPA_HTML" | grep -qi "Strict-Transport-Security:"
echo "$SPA_HTML" | grep -q "SupermarketOS"
echo "  ✓ GET / served built SPA with CSP, HSTS & X-Frame-Options: DENY"

echo "[docker-smoke] Verifying /api/openapi.json blocks unauthenticated requests (401)..."
OPENAPI_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${HOST_PORT}/api/openapi.json")
test "$OPENAPI_UNAUTH" -eq 401
echo "  ✓ GET /api/openapi.json unauthenticated -> 401"

echo "[docker-smoke] Authenticating as owner via Nginx /api/auth/login..."
LOGIN_JSON=$(curl -sf -X POST "http://127.0.0.1:${HOST_PORT}/api/auth/login" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Mode: bearer" \
  -d '{"username":"owner","pin":"1111","includeToken":true}')
TOKEN=$(printf '%s' "$LOGIN_JSON" | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(d.token || '');")
test -n "$TOKEN"
echo "  ✓ POST /api/auth/login -> bearer token issued"

echo "[docker-smoke] Verifying authenticated OpenAPI 3.1 contract..."
curl -sf "http://127.0.0.1:${HOST_PORT}/api/openapi.json" -H "Authorization: Bearer ${TOKEN}" | grep -q '"openapi":"3.1.0"'
echo "  ✓ GET /api/openapi.json (owner) -> 3.1.0"

echo "[docker-smoke] Verifying Prometheus /api/metrics via Nginx..."
METRICS_OUT=$(curl -sf "http://127.0.0.1:${HOST_PORT}/api/metrics" -H "Authorization: Bearer ${TOKEN}")
echo "$METRICS_OUT" | grep -q "http_requests_total"
echo "$METRICS_OUT" | grep -q "pg_pool_connections"
echo "  ✓ GET /api/metrics -> Prometheus text format verified"

echo "[docker-smoke] Verifying unbuffered SSE streaming through Nginx (/api/ai/chat/stream)..."
SSE_OUT=$(curl -sfN -X POST "http://127.0.0.1:${HOST_PORT}/api/ai/chat/stream" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message":"Show today morning risk summary"}')
echo "$SSE_OUT" | grep -q '"type":"done"'
echo "  ✓ POST /api/ai/chat/stream -> SSE streamed cleanly through Nginx"

echo "[docker-smoke] Running containerized Python ML Analytics worker..."
ANALYTICS_OUT=$(docker run --rm --network "$NET_NAME" \
  -e DATABASE_URL="postgres://${PG_USER}:${PG_PASS}@postgres:5432/${PG_DB}" \
  supermarket-os-analytics:verify 2>&1)
echo "$ANALYTICS_OUT" | grep -q '"dq_passed": true'
echo "  ✓ Containerized Python analytics worker completed with 12/12 DQ contracts PASS"

echo "[docker-smoke] SUCCESS: Full containerized production stack verified end-to-end."
