#!/usr/bin/env bash
# =============================================================================
# DEMO: fallo inducido en la SAGA y verificacion del rollback distribuido
#
#   scripts/demo/saga-fault.sh <dev|test|prod>
#
#   1. Activa SIMULATE_CHARGER_HARDWARE_FAULT en la tabla de flags del ambiente.
#   2. Dispara la mutacion GraphQL reserveAndCharge por el API Gateway.
#   3. Muestra en las tablas DynamoDB el cobro, su reembolso y el conector libre.
#   4. Rastrea la transaccion en CloudWatch por correlation_id.
#   5. Vuelve a apagar la flag.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
require_env "$ENV_NAME"
FLEET="${FLEET:-FLEET-ANDES}"; STATION="${STATION:-ST-BOG-01}"; CONNECTOR="${CONNECTOR:-C3}"
URL="${FLOCI_ENDPOINT}/execute-api/${PROJECT}-${ENV_NAME}/${ENV_NAME}/graphql"
DEMO="$REPO_ROOT/scripts/demo"

balance() {
  aws dynamodb get-item --table-name "aegisvolt-billing-${ENV_NAME}" --consistent-read \
    --key "{\"pk\":{\"S\":\"WALLET#$FLEET\"},\"sk\":{\"S\":\"BALANCE\"}}" --query 'Item.balance.N' --output text
}

log "1) Activando la flag de fallo en $ENV_NAME"
"$DEMO/set-flag.sh" "$ENV_NAME" SIMULATE_CHARGER_HARDWARE_FAULT true >/dev/null
trap '"$DEMO/set-flag.sh" "$ENV_NAME" SIMULATE_CHARGER_HARDWARE_FAULT false >/dev/null; log "Flag de fallo apagada de nuevo"' EXIT
sleep 4 # cache de flags de los servicios (3 s)

before="$(balance)"
log "2) Saldo de $FLEET antes: $before. Disparando la mutacion reserveAndCharge ($STATION/$CONNECTOR)"
response="$(curl -s -m 30 -X POST "$URL" -H 'content-type: application/json' -d "{\"query\":\"mutation { reserveAndCharge(input: {fleetId: \\\"$FLEET\\\", stationId: \\\"$STATION\\\", connectorId: \\\"$CONNECTOR\\\", estimatedKwh: 20}) { sagaId status correlationId amount failure { step code } steps { name status compensation { name status } } } }\"}")"

read -r SAGA_ID CORRELATION_ID < <(node -e '
  const saga = JSON.parse(process.argv[1]).data.reserveAndCharge;
  console.error(`   SAGA ${saga.sagaId}: ${saga.status} (fallo en ${saga.failure?.step}: ${saga.failure?.code})`);
  for (const s of saga.steps) console.error(`     ${s.name.padEnd(20)} ${s.status.padEnd(10)} ${s.compensation ? s.compensation.name + "=" + s.compensation.status : ""}`);
  console.log(saga.sagaId, saga.correlationId);
' "$response")

log "3) Evidencia en DynamoDB"
echo "   aegisvolt-billing-${ENV_NAME}: movimientos de la SAGA (cobro y evento de reversion)"
aws dynamodb query --table-name "aegisvolt-billing-${ENV_NAME}" --consistent-read \
  --key-condition-expression "pk = :pk AND begins_with(sk, :sk)" \
  --expression-attribute-values "{\":pk\":{\"S\":\"WALLET#$FLEET\"},\":sk\":{\"S\":\"TX#$SAGA_ID#\"}}" \
  --query 'Items[].[type.S, status.S, amount.N, reason.S]' --output table
echo "   Saldo antes=$before  despues=$(balance)"
echo "   aegisvolt-reservations-${ENV_NAME}: conector y reserva"
aws dynamodb get-item --table-name "aegisvolt-reservations-${ENV_NAME}" --consistent-read \
  --key "{\"pk\":{\"S\":\"STATION#$STATION\"},\"sk\":{\"S\":\"CONNECTOR#$CONNECTOR\"}}" \
  --query 'Item.{conector:connectorId.S, estado:status.S, reservadoPor:reservedBy.S}' --output table
aws dynamodb get-item --table-name "aegisvolt-reservations-${ENV_NAME}" --consistent-read \
  --key "{\"pk\":{\"S\":\"RESERVATION#$SAGA_ID\"},\"sk\":{\"S\":\"META\"}}" \
  --query 'Item.{reserva:status.S, motivo:statusReason.S}' --output table
echo "   aegisvolt-sagas-${ENV_NAME}: registro de la SAGA"
aws dynamodb get-item --table-name "aegisvolt-sagas-${ENV_NAME}" --consistent-read \
  --key "{\"pk\":{\"S\":\"SAGA#$SAGA_ID\"},\"sk\":{\"S\":\"META\"}}" \
  --query 'Item.{estado:status.S, pasoFallido:failure.M.step.S, codigo:failure.M.code.S}' --output table

log "4) Traza en CloudWatch (los logs se envian en lotes cada 2 s)"
sleep 4
"$DEMO/trace.sh" "$ENV_NAME" "$CORRELATION_ID"
