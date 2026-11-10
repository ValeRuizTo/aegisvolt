#!/usr/bin/env bash
# =============================================================================
# Job "e2e-tests" del Pull Request.
#
#   1. Crea tablas DynamoDB temporales (sufijo unico) en Floci.
#   2. Levanta la plataforma completa con docker compose (imagenes reales).
#   3. Ejecuta tests/e2e contra el frontend.
#   4. Apaga todo y borra las tablas (siempre, pase o falle).
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

export E2E_ENV="e2e$(date +%s | tail -c 7)"
COMPOSE=(docker compose -f "$REPO_ROOT/tests/e2e/docker-compose.yml")
TABLES_PKSK="reservations billing dispatch sagas"

cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    warn "E2E fallidos: ultimos logs del gateway"
    "${COMPOSE[@]}" logs --tail 30 graphql-gateway 2>/dev/null || true
  fi
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
  for domain in $TABLES_PKSK feature-flags; do
    aws dynamodb delete-table --table-name "aegisvolt-${domain}-${E2E_ENV}" >/dev/null 2>&1 || true
  done
  for service in $SERVICES; do
    aws logs delete-log-group --log-group-name "/aegisvolt/${E2E_ENV}/${service}" >/dev/null 2>&1 || true
  done
  exit $code
}
trap cleanup EXIT

log "Creando tablas temporales del ambiente efimero $E2E_ENV"
for domain in $TABLES_PKSK; do
  aws dynamodb create-table --table-name "aegisvolt-${domain}-${E2E_ENV}" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE >/dev/null
done
aws dynamodb create-table --table-name "aegisvolt-feature-flags-${E2E_ENV}" --billing-mode PAY_PER_REQUEST \
  --attribute-definitions AttributeName=flag_name,AttributeType=S \
  --key-schema AttributeName=flag_name,KeyType=HASH >/dev/null
for flag in ENABLE_DYNAMIC_SURGE_PRICING ENABLE_FAST_CHARGE_BOOST SIMULATE_CHARGER_HARDWARE_FAULT; do
  aws dynamodb put-item --table-name "aegisvolt-feature-flags-${E2E_ENV}" \
    --item "{\"flag_name\":{\"S\":\"$flag\"},\"enabled\":{\"BOOL\":false},\"description\":{\"S\":\"e2e\"}}" >/dev/null
done

log "Levantando la plataforma (docker compose)"
retry "${COMPOSE[@]}" up -d --build --quiet-pull >/dev/null 2>&1 || die "No se pudo levantar el stack E2E"

# En la maquina local el frontend se publica en localhost:8088; dentro de la
# red Docker (runner de CI) se alcanza por el nombre del contenedor.
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:8088}"
log "Ejecutando pruebas E2E contra $E2E_BASE_URL"
cd "$REPO_ROOT"
npm run --silent test:e2e
ok "Pruebas E2E superadas"
