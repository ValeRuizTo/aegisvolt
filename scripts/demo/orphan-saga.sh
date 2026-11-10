#!/usr/bin/env bash
# =============================================================================
# DEMO: SAGA huerfana detectada por Prefect y recuperada con compensateSaga
#
#   scripts/demo/orphan-saga.sh <dev|test>            crea la SAGA huerfana
#   scripts/demo/orphan-saga.sh <dev|test> recover    la recupera (compensa)
#
# Reproduce lo que dejaria un orquestador que muere justo despues de cobrar:
# conector RESERVED, saldo descontado y la SAGA "STARTED" para siempre.
# Las dos primeras operaciones se hacen llamando a los microservicios reales
# (kubectl exec), no escribiendo a mano en sus tablas.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"; ACTION="${2:-create}"
require_env "$ENV_NAME"
[[ "$ENV_NAME" != "prod" ]] || die "Esta demo no se ejecuta en prod"
SAGA_ID="orphan-demo-${ENV_NAME}"
URL="${FLOCI_ENDPOINT}/execute-api/${PROJECT}-${ENV_NAME}/${ENV_NAME}/graphql"

if [[ "$ACTION" == "recover" ]]; then
  log "Recuperando la SAGA $SAGA_ID con la mutacion compensateSaga"
  curl -s -m 30 -X POST "$URL" -H 'content-type: application/json' \
    -d "{\"query\":\"mutation { compensateSaga(sagaId: \\\"$SAGA_ID\\\") { sagaId status failure { code } steps { name compensation { name status } } } }\"}"
  echo
  exit 0
fi

use_cluster "$ENV_NAME"
post() { # post <servicio> <ruta> <json>
  kubectl -n aegisvolt exec "deploy/graphql-gateway-stable" -c app -- node -e '
    const [url, body] = process.argv.slice(1);
    fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-correlation-id": "corr-orphan-demo" }, body })
      .then(async (r) => console.log(r.status, (await r.text()).slice(0, 120)));' "http://$1:3000$2" "$3"
}
log "Paso 1 real: reservar conector ST-CAL-01/C2"
post station-reservation-service /reservations "{\"sagaId\":\"$SAGA_ID\",\"stationId\":\"ST-CAL-01\",\"connectorId\":\"C2\",\"fleetId\":\"FLEET-PACIFICO\"}"
log "Paso 2 real: cobrar a FLEET-PACIFICO"
post billing-wallet-service /charges "{\"sagaId\":\"$SAGA_ID\",\"fleetId\":\"FLEET-PACIFICO\",\"estimatedKwh\":10}"

old="$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%S.000Z)"
step() { echo "{\"M\":{\"name\":{\"S\":\"$1\"},\"service\":{\"S\":\"$2\"},\"status\":{\"S\":\"$3\"},\"attempts\":{\"N\":\"1\"},\"compensation\":$4}}"; }
comp() { echo "{\"M\":{\"name\":{\"S\":\"$1\"},\"status\":{\"S\":\"NOT_REQUIRED\"},\"attempts\":{\"N\":\"0\"}}}"; }
log "Registro de la SAGA detenido en STARTED (orquestador 'caido' hace 15 minutos)"
aws dynamodb put-item --table-name "aegisvolt-sagas-${ENV_NAME}" --item "{
  \"pk\":{\"S\":\"SAGA#$SAGA_ID\"},\"sk\":{\"S\":\"META\"},\"sagaId\":{\"S\":\"$SAGA_ID\"},
  \"type\":{\"S\":\"RESERVE_AND_CHARGE\"},\"status\":{\"S\":\"STARTED\"},\"environment\":{\"S\":\"$ENV_NAME\"},
  \"correlationId\":{\"S\":\"corr-orphan-demo\"},
  \"input\":{\"M\":{\"fleetId\":{\"S\":\"FLEET-PACIFICO\"},\"stationId\":{\"S\":\"ST-CAL-01\"},\"connectorId\":{\"S\":\"C2\"},\"estimatedKwh\":{\"N\":\"10\"},\"fastCharge\":{\"BOOL\":false}}},
  \"context\":{\"M\":{\"powerKw\":{\"N\":\"60\"}}},
  \"steps\":{\"L\":[
    $(step RESERVE_CONNECTOR station-reservation-service SUCCEEDED "$(comp RELEASE_CONNECTOR)"),
    $(step CHARGE_WALLET billing-wallet-service SUCCEEDED "$(comp REFUND_WALLET)"),
    $(step START_CHARGING energy-dispatch-service RUNNING "$(comp STOP_CHARGING)"),
    $(step CONFIRM_RESERVATION station-reservation-service PENDING '{"NULL":true}')
  ]},
  \"createdAt\":{\"S\":\"$old\"},\"updatedAt\":{\"S\":\"$old\"}
}"
ok "SAGA huerfana $SAGA_ID creada en $ENV_NAME."
echo "  - El frontend la muestra 'En curso' y el conector ST-CAL-01/C2 queda Reservado."
echo "  - Prefect la reportara en la proxima ejecucion (http://localhost:4200)."
echo "  - Recuperela con: scripts/demo/orphan-saga.sh $ENV_NAME recover"
