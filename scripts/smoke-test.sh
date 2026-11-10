#!/usr/bin/env bash
# =============================================================================
# Prueba de humo de un ambiente desplegado, entrando por el API Gateway
# (el mismo camino que recorre un usuario).
#
#   scripts/smoke-test.sh <dev|test|prod>
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ENV_NAME="${1:-}"
require_env "$ENV_NAME"
BASE_URL="${FLOCI_ENDPOINT}/execute-api/${PROJECT}-${ENV_NAME}/${ENV_NAME}"

log "Prueba de humo de $ENV_NAME -> $BASE_URL"

# 1. El frontend responde.
code="$(curl -s -o "$NULL_DEVICE" -m 15 -w '%{http_code}' "$BASE_URL/" || true)"
[[ "$code" == "200" ]] || die "El frontend respondio HTTP $code"

# 2. GraphQL responde y reporta el ambiente correcto y los 4 servicios sanos.
response="$(curl -s -m 20 -X POST "$BASE_URL/graphql" -H 'content-type: application/json' \
  -d '{"query":"{ environment { name services { name status } } stations { stationId } featureFlags { name enabled } }"}')"

node -e '
  const [expectedEnv, raw] = process.argv.slice(1);
  let body;
  try { body = JSON.parse(raw); } catch { console.error("Respuesta no JSON: " + raw.slice(0, 300)); process.exit(1); }
  if (body.errors) { console.error("GraphQL devolvio errores: " + JSON.stringify(body.errors)); process.exit(1); }
  const { environment, stations, featureFlags } = body.data;
  const problems = [];
  if (environment.name !== expectedEnv) problems.push(`ambiente ${environment.name}, se esperaba ${expectedEnv}`);
  for (const s of environment.services) if (s.status !== "ok") problems.push(`servicio ${s.name}: ${s.status}`);
  if (stations.length === 0) problems.push("sin estaciones");
  if (featureFlags.length !== 3) problems.push(`se esperaban 3 flags, hay ${featureFlags.length}`);
  if (problems.length) { console.error("Fallos: " + problems.join("; ")); process.exit(1); }
  console.error(`  ambiente=${environment.name} servicios_ok=${environment.services.length} estaciones=${stations.length} flags=${featureFlags.map((f) => f.name + "=" + f.enabled).join(", ")}`);
' "$ENV_NAME" "$response" || die "La prueba de humo de $ENV_NAME fallo"

ok "Ambiente $ENV_NAME operativo: $BASE_URL/"
