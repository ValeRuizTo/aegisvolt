#!/usr/bin/env bash
# =============================================================================
# Cambia una Feature Flag de UN ambiente escribiendo directamente en su tabla
# DynamoDB (sin redesplegar nada).
#
#   scripts/demo/set-flag.sh <dev|test|prod> <FLAG> <true|false>
#   scripts/demo/set-flag.sh dev            (sin mas argumentos: lista las flags)
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"; FLAG="${2:-}"; VALUE="${3:-}"
require_env "$ENV_NAME"
TABLE="aegisvolt-feature-flags-${ENV_NAME}"

if [[ -n "$FLAG" ]]; then
  [[ "$VALUE" == "true" || "$VALUE" == "false" ]] || die "Valor invalido: use true o false"
  aws dynamodb update-item --table-name "$TABLE" \
    --key "{\"flag_name\":{\"S\":\"$FLAG\"}}" \
    --update-expression "SET enabled = :v, updated_at = :t, updated_by = :b" \
    --condition-expression "attribute_exists(flag_name)" \
    --expression-attribute-values "{\":v\":{\"BOOL\":$VALUE},\":t\":{\"S\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"},\":b\":{\"S\":\"aws-cli\"}}" >/dev/null
  ok "$FLAG = $VALUE en $ENV_NAME (tabla $TABLE). Los servicios lo veran en <= 3 s."
fi

aws dynamodb scan --table-name "$TABLE" \
  --query 'Items[].[flag_name.S, enabled.BOOL, updated_by.S]' --output table
