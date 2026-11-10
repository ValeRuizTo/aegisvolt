#!/usr/bin/env bash
# =============================================================================
# CANARY DEPLOYMENT de un microservicio
#
#   scripts/deploy/canary.sh <dev|test|prod> <servicio> <version>
#
# Fases:
#   1. CANARY    Se crea <servicio>-canary con 1 replica de la version nueva.
#                La version estable sigue con 4 replicas => ~20 % del trafico
#                del Service llega a la version nueva y ~80 % a la estable.
#   2. ANALISIS  Se evaluan TRES condiciones sobre la version nueva:
#                  a) los pods canary quedaron Ready y no se reiniciaron;
#                  b) tasa de exito de peticiones de prueba >= umbral (95 %);
#                  c) tasa de error en CloudWatch (ErrorCount / RequestCount de
#                     la dimension Version=<nueva>) <= maximo permitido (5 %).
#   3a. PROMOCION  Si TODO se cumple: la version nueva pasa al 100 % de las
#                  replicas (rolling update del Deployment estable) y se
#                  elimina el canary.
#   3b. ROLLBACK   Si algo falla: se elimina el canary. La version estable
#                  nunca se toco, asi que el 100 % del trafico vuelve a ella.
#                  El script termina con error y el pipeline queda en rojo.
#
# Variables opcionales:
#   CANARY_FAULT_RATE   fraccion de peticiones que el canary hara fallar (demo)
#   STABLE_REPLICAS=4  CANARY_REPLICAS=1  SUCCESS_THRESHOLD=95  MAX_ERROR_RATE=5
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
SERVICE="${2:-}"
VERSION="${3:-}"
require_env "$ENV_NAME"
[[ -n "$SERVICE" && -n "$VERSION" ]] || die "Uso: canary.sh <ambiente> <servicio> <version>"

STABLE_REPLICAS="${STABLE_REPLICAS:-4}"
CANARY_REPLICAS="${CANARY_REPLICAS:-1}"
SUCCESS_THRESHOLD="${SUCCESS_THRESHOLD:-95}" # % minimo de peticiones correctas
MAX_ERROR_RATE="${MAX_ERROR_RATE:-5}"        # % maximo de errores en CloudWatch
PROBE_COUNT="${PROBE_COUNT:-40}"
CANARY_FAULT_RATE="${CANARY_FAULT_RATE:-0}"

NS="aegisvolt"
IMAGE="${ECR_REGISTRY}/${PROJECT}/${SERVICE}:${VERSION}"
TAG="[$ENV_NAME/$SERVICE]"

# Las llamadas a CloudWatch usan las credenciales actuales; kubectl, las del deployer.
use_cluster "$ENV_NAME"

# --- utilidades ---------------------------------------------------------------
json_field() { # json_field <campo>  (lee JSON por stdin)
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const value = process.argv[1].split(".").reduce((acc, key) => acc?.[key], data);
    process.stdout.write(String(value ?? ""));
  ' "$1"
}

render() { # render <track> <replicas> <fault_rate>
  SERVICE="$SERVICE" TRACK="$1" REPLICAS="$2" IMAGE="$IMAGE" VERSION="$VERSION" FAULT_INJECTION_RATE="$3" \
    envsubst '${SERVICE} ${TRACK} ${REPLICAS} ${IMAGE} ${VERSION} ${FAULT_INJECTION_RATE}' \
    <"$REPO_ROOT/k8s/microservice.yaml"
}

# Deja constancia del evento de despliegue en CloudWatch Logs.
record_event() { # record_event <evento> <detalle>
  local group="/aegisvolt/${ENV_NAME}/deployments" stream="canary-${SERVICE}"
  local message
  message="$(node -e 'process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(), level: process.argv[1] === "CANARY_ROLLBACK" ? "ERROR" : "INFO",
      message: process.argv[1], environment: process.argv[2], service: process.argv[3],
      version: process.argv[4], detail: process.argv[5] }))' "$1" "$ENV_NAME" "$SERVICE" "$VERSION" "$2")"
  aws logs create-log-stream --log-group-name "$group" --log-stream-name "$stream" >/dev/null 2>&1 || true
  aws logs put-log-events --log-group-name "$group" --log-stream-name "$stream" \
    --log-events "$(node -e 'process.stdout.write(JSON.stringify([{ timestamp: Date.now(), message: process.argv[1] }]))' "$message")" \
    >/dev/null 2>&1 || warn "$TAG no se pudo registrar el evento en CloudWatch"
}

rollback() { # rollback <motivo>
  warn "$TAG ROLLBACK AUTOMATICO: $1"
  kubectl -n "$NS" delete deployment "${SERVICE}-canary" --ignore-not-found --wait=true >/dev/null
  record_event "CANARY_ROLLBACK" "$1"
  die "$TAG canary revertido. La version estable (${CURRENT_VERSION:-ninguna}) sigue atendiendo el 100 % del trafico."
}

# Ruta representativa de cada servicio para las peticiones de prueba.
probe_args() {
  case "$SERVICE" in
    station-reservation-service) echo "--url http://$1:3000/stations" ;;
    billing-wallet-service)      echo "--url http://$1:3000/wallets" ;;
    energy-dispatch-service)     echo "--url http://$1:3000/sessions" ;;
    graphql-gateway)             echo "--url http://$1:3000/graphql --method POST --body {\"query\":\"{stations{stationId}}\"}" ;;
    *) die "Servicio desconocido: $SERVICE" ;;
  esac
}

# Ejecuta la sonda dentro de un pod (asi se mide desde DENTRO del cluster).
run_probe() { # run_probe <pod> <host destino> <cantidad>
  # shellcheck disable=SC2046
  kubectl -n "$NS" exec "$1" -c app -- node packages/common/bin/probe.mjs $(probe_args "$2") --count "$3" 2>/dev/null | tail -1
}

# =============================================================================
# 0. Estado actual
# =============================================================================
CURRENT_VERSION="$(kubectl -n "$NS" get deployment "${SERVICE}-stable" \
  -o jsonpath='{.spec.template.metadata.labels.version}' 2>/dev/null || true)"

if [[ -z "$CURRENT_VERSION" ]]; then
  # Primer despliegue del servicio: no existe version estable que proteger.
  log "$TAG primer despliegue: se crea directamente la version estable $VERSION"
  render stable "$STABLE_REPLICAS" 0 | kubectl apply -f - >/dev/null
  kubectl -n "$NS" rollout status "deployment/${SERVICE}-stable" --timeout=240s >/dev/null \
    || die "$TAG el primer despliegue no quedo listo"
  record_event "INITIAL_DEPLOY" "primer despliegue, sin canary"
  ok "$TAG version $VERSION desplegada ($STABLE_REPLICAS replicas)"
  exit 0
fi

if [[ "$CURRENT_VERSION" == "$VERSION" && "$CANARY_FAULT_RATE" == "0" ]]; then
  kubectl -n "$NS" delete deployment "${SERVICE}-canary" --ignore-not-found >/dev/null
  ok "$TAG ya esta en la version $VERSION: nada que desplegar"
  exit 0
fi

log "$TAG version estable actual: $CURRENT_VERSION  ->  version candidata: $VERSION"
ANALYSIS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# =============================================================================
# 1. CANARY: 1 replica nueva junto a las estables
# =============================================================================
total=$((STABLE_REPLICAS + CANARY_REPLICAS))
log "$TAG fase 1/3 CANARY: $CANARY_REPLICAS replica nueva + $STABLE_REPLICAS estables (~$((CANARY_REPLICAS * 100 / total)) % del trafico a la version nueva)"
render canary "$CANARY_REPLICAS" "$CANARY_FAULT_RATE" | kubectl apply -f - >/dev/null
record_event "CANARY_STARTED" "canary=$CANARY_REPLICAS stable=$STABLE_REPLICAS previous=$CURRENT_VERSION"

if ! kubectl -n "$NS" rollout status "deployment/${SERVICE}-canary" --timeout=180s >/dev/null 2>&1; then
  rollback "los pods canary no pasaron el health check (readiness) en 180 s"
fi

# =============================================================================
# 2. ANALISIS
# =============================================================================
log "$TAG fase 2/3 ANALISIS de la version $VERSION"
stable_pod="$(kubectl -n "$NS" get pods -l "app=${SERVICE},track=stable" \
  --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
canary_ip="$(kubectl -n "$NS" get pods -l "app=${SERVICE},track=canary" -o jsonpath='{.items[0].status.podIP}')"

# 2.1 Reparto real del trafico a traves del Service (informativo).
split="$(run_probe "$stable_pod" "$SERVICE" 50)"
[[ -n "$split" ]] && log "$TAG reparto de 50 peticiones via Service: $(node -e '
  const s = JSON.parse(process.argv[1]); const t = s.total || 1;
  process.stdout.write(Object.entries(s.byTrack).map(([k, v]) => `${k}=${v} (${Math.round(v * 100 / t)} %)`).join("  "));' "$split")"

# 2.2 Condicion (b): peticiones de prueba dirigidas SOLO al pod canary.
probe="$(run_probe "$stable_pod" "$canary_ip" "$PROBE_COUNT")"
[[ -n "$probe" ]] || rollback "no se pudo ejecutar la sonda contra el canary"
success_rate="$(json_field successRate <<<"$probe")"
log "$TAG (b) peticiones de prueba al canary: $(json_field ok <<<"$probe")/$(json_field total <<<"$probe") correctas -> exito ${success_rate} % (umbral >= ${SUCCESS_THRESHOLD} %)"

# 2.3 Condicion (a): pods Ready y sin reinicios.
ready="$(kubectl -n "$NS" get deployment "${SERVICE}-canary" -o jsonpath='{.status.readyReplicas}')"
restarts="$(kubectl -n "$NS" get pods -l "app=${SERVICE},track=canary" \
  -o jsonpath='{range .items[*]}{.status.containerStatuses[0].restartCount}{"\n"}{end}' | awk '{s+=$1} END {print s+0}')"
log "$TAG (a) pods canary Ready: ${ready:-0}/${CANARY_REPLICAS}, reinicios: $restarts"

# 2.4 Condicion (c): metricas de error en CloudWatch para la version nueva.
#     Los servicios publican cada 10 s; se espera a que el dato este disponible.
sleep 13
metric_sum() { # metric_sum <MetricName>
  aws cloudwatch get-metric-statistics --namespace AegisVolt --metric-name "$1" \
    --dimensions "Name=Environment,Value=$ENV_NAME" "Name=Service,Value=$SERVICE" "Name=Version,Value=$VERSION" \
    --start-time "$ANALYSIS_START" --end-time "$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)" \
    --period 3600 --statistics Sum --query 'Datapoints[].Sum' --output text 2>/dev/null \
    | tr -s '\t\r\n' ' ' | awk '{s=0; for (i=1; i<=NF; i++) s+=$i; print s+0}'
}
cw_requests="$(metric_sum RequestCount)"
cw_errors="$(metric_sum ErrorCount)"
cw_error_rate="$(awk -v e="$cw_errors" -v r="$cw_requests" 'BEGIN { if (r > 0) printf "%.1f", e * 100 / r; else print "NA" }')"
log "$TAG (c) CloudWatch Version=$VERSION: RequestCount=$cw_requests ErrorCount=$cw_errors -> error ${cw_error_rate} % (maximo <= ${MAX_ERROR_RATE} %)"

# --- Decision -----------------------------------------------------------------
[[ "${ready:-0}" == "$CANARY_REPLICAS" ]] || rollback "pods canary no estan Ready (${ready:-0}/${CANARY_REPLICAS})"
[[ "$restarts" == "0" ]] || rollback "los pods canary se reiniciaron $restarts veces"
awk -v v="$success_rate" -v t="$SUCCESS_THRESHOLD" 'BEGIN { exit !(v >= t) }' \
  || rollback "tasa de exito ${success_rate} % por debajo del umbral ${SUCCESS_THRESHOLD} %"
[[ "$cw_error_rate" != "NA" ]] || rollback "CloudWatch no tiene metricas de la version nueva (no se puede evaluar)"
awk -v v="$cw_error_rate" -v t="$MAX_ERROR_RATE" 'BEGIN { exit !(v <= t) }' \
  || rollback "tasa de error en CloudWatch ${cw_error_rate} % supera el maximo ${MAX_ERROR_RATE} %"

# =============================================================================
# 3. PROMOCION al 100 %
# =============================================================================
log "$TAG fase 3/3 PROMOCION: umbrales cumplidos, la version $VERSION pasa al 100 % de las replicas"
render stable "$STABLE_REPLICAS" 0 | kubectl apply -f - >/dev/null
if ! kubectl -n "$NS" rollout status "deployment/${SERVICE}-stable" --timeout=300s >/dev/null 2>&1; then
  kubectl -n "$NS" rollout undo "deployment/${SERVICE}-stable" >/dev/null || true
  rollback "la promocion no termino; se deshizo el rolling update de la version estable"
fi
kubectl -n "$NS" delete deployment "${SERVICE}-canary" --ignore-not-found >/dev/null
record_event "CANARY_PROMOTED" "success_rate=${success_rate} cloudwatch_error_rate=${cw_error_rate} previous=${CURRENT_VERSION}"
ok "$TAG version $VERSION promovida al 100 % ($STABLE_REPLICAS replicas). Canary eliminado."
