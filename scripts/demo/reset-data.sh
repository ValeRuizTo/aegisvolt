#!/usr/bin/env bash
# =============================================================================
# Devuelve los DATOS de un ambiente a su estado inicial (no toca la
# infraestructura ni las feature flags).
#
#   scripts/demo/reset-data.sh <dev|test|prod>
#
# Vacia las tablas reservations, billing, dispatch y sagas, y reinicia los pods
# para que cada servicio vuelva a sembrar sus datos iniciales.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
require_env "$ENV_NAME"

for domain in reservations billing dispatch sagas; do
  table="aegisvolt-${domain}-${ENV_NAME}"
  count=0
  while read -r pk sk; do
    [[ -n "$pk" ]] || continue
    aws dynamodb delete-item --table-name "$table" --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}"
    count=$((count + 1))
  done < <(aws dynamodb scan --table-name "$table" --projection-expression "pk, sk" \
            --query 'Items[].[pk.S, sk.S]' --output text | tr -d '\r')
  log "$table: $count items eliminados"
done

use_cluster "$ENV_NAME"
for service in station-reservation-service billing-wallet-service energy-dispatch-service; do
  kubectl -n aegisvolt rollout restart "deployment/${service}-stable" >/dev/null
done
for service in station-reservation-service billing-wallet-service energy-dispatch-service; do
  kubectl -n aegisvolt rollout status "deployment/${service}-stable" --timeout=180s >/dev/null
done
ok "Datos de $ENV_NAME reiniciados (estaciones y billeteras sembradas de nuevo)"
