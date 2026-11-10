#!/usr/bin/env bash
# =============================================================================
# DEMO: canary defectuoso -> rollback automatico
#
#   scripts/demo/canary-rollback.sh <dev|test|prod> [servicio]
#
# Publica la imagen actual con un tag nuevo ("<version>-bad") y la despliega
# como canary con inyeccion de fallos (60 % de las peticiones responden 500).
# El analisis detecta la tasa de error y elimina el canary; la version estable
# no se toca. El script termina con codigo de salida distinto de cero, igual
# que quedaria en rojo el pipeline.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
SERVICE="${2:-billing-wallet-service}"
require_env "$ENV_NAME"

use_cluster "$ENV_NAME"
current="$(kubectl -n aegisvolt get deployment "${SERVICE}-stable" -o jsonpath='{.spec.template.metadata.labels.version}')"
[[ -n "$current" ]] || die "No hay version estable de $SERVICE en $ENV_NAME"
bad="${current%-bad}-bad"

repo="${ECR_REGISTRY}/${PROJECT}/${SERVICE}"
log "Publicando $repo:$bad (misma imagen que $current, se rompera con FAULT_INJECTION_RATE)"
docker pull --quiet "$repo:$current" >/dev/null 2>&1 || true
docker tag "$repo:$current" "$repo:$bad"
docker push --quiet "$repo:$bad" >/dev/null

CANARY_FAULT_RATE="${CANARY_FAULT_RATE:-0.6}" "$REPO_ROOT/scripts/deploy/canary.sh" "$ENV_NAME" "$SERVICE" "$bad"
