#!/usr/bin/env bash
# =============================================================================
# Rastrea una transaccion en CloudWatch Logs por su correlation_id: recorre los
# grupos /aegisvolt/<ambiente>/<servicio> y muestra, en orden cronologico, lo
# que cada microservicio registro para esa SAGA.
#
#   scripts/demo/trace.sh <dev|test|prod> <correlation_id>
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"; CORRELATION_ID="${2:-}"
require_env "$ENV_NAME"
[[ -n "$CORRELATION_ID" ]] || die "Uso: trace.sh <ambiente> <correlation_id>"

log "Logs de CloudWatch con correlation_id=$CORRELATION_ID en /aegisvolt/$ENV_NAME/*"
for service in $SERVICES; do
  aws logs filter-log-events --log-group-name "/aegisvolt/${ENV_NAME}/${service}" \
    --filter-pattern "\"$CORRELATION_ID\"" --query 'events[].message' --output json
done | node -e '
  const chunks = require("fs").readFileSync(0, "utf8").trim().split(/\n(?=\[)/);
  const events = chunks.flatMap((c) => JSON.parse(c)).map((m) => JSON.parse(m))
    .filter((e) => e.message !== "http_request")
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const e of events) {
    const extra = [e.saga_step && `paso=${e.saga_step}`, e.compensation && "COMPENSACION", e.error_code && `error=${e.error_code}`,
      e.amount != null && `valor=${e.amount}`, e.balance_after != null && `saldo=${e.balance_after}`].filter(Boolean).join(" ");
    console.log(`${e.timestamp.slice(11, 23)}  ${e.level.padEnd(5)} ${e.service.padEnd(28)} ${e.message}  ${extra}`);
  }
  console.log(`\n${events.length} eventos de ${new Set(events.map((e) => e.service)).size} servicios`);
'
