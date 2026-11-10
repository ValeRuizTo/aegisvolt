#!/usr/bin/env bash
# =============================================================================
# Prepara el cluster de un ambiente: namespace, Services, ConfigMap y Secret.
#
#   scripts/deploy/configure-env.sh <dev|test|prod>
#
# El ConfigMap es el puente entre Terraform y Kubernetes: los nombres de las
# tablas y del grupo de logs se LEEN de los outputs de Terraform del workspace
# del ambiente. Un pod de dev recibe las tablas de dev y no conoce otras.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
require_env "$ENV_NAME"

# Outputs de Terraform del workspace del ambiente (JSON -> valores sueltos).
tf_outputs="$("$REPO_ROOT/scripts/tf.sh" "$ENV_NAME" output -json 2>/dev/null | tr -d '\r')"
out() {
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const value = process.argv[1].split(".").reduce((acc, key) => acc?.[key], data);
    if (value === undefined) { console.error("output inexistente: " + process.argv[1]); process.exit(1); }
    process.stdout.write(String(value));
  ' "$1" <<<"$tf_outputs"
}

use_cluster "$ENV_NAME"
log "Configurando el cluster $(kubectl config current-context)"

kubectl apply -f "$REPO_ROOT/k8s/services.yaml" >/dev/null

# --- ConfigMap: configuracion NO sensible del ambiente ------------------------
kubectl -n aegisvolt create configmap aegisvolt-config \
  --from-literal=APP_ENV="$ENV_NAME" \
  --from-literal=AWS_REGION="$AWS_DEFAULT_REGION" \
  --from-literal=AWS_ENDPOINT_URL="http://${FLOCI_INTERNAL_IP}:4566" \
  --from-literal=TABLE_RESERVATIONS="$(out dynamodb_tables.value.reservations)" \
  --from-literal=TABLE_BILLING="$(out dynamodb_tables.value.billing)" \
  --from-literal=TABLE_DISPATCH="$(out dynamodb_tables.value.dispatch)" \
  --from-literal=TABLE_SAGAS="$(out dynamodb_tables.value.sagas)" \
  --from-literal=TABLE_FEATURE_FLAGS="$(out dynamodb_tables.value.feature-flags)" \
  --from-literal=LOG_GROUP_PREFIX="$(out log_group_prefix.value)" \
  --from-literal=CLOUDWATCH_LOGS_ENABLED=true \
  --from-literal=CLOUDWATCH_METRICS_ENABLED=true \
  --from-literal=STATION_SERVICE_URL=http://station-reservation-service:3000 \
  --from-literal=BILLING_SERVICE_URL=http://billing-wallet-service:3000 \
  --from-literal=DISPATCH_SERVICE_URL=http://energy-dispatch-service:3000 \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# --- Secret: credenciales AWS de los pods -------------------------------------
# En Floci cualquier credencial es valida. En AWS real NO habria Secret: cada
# pod asumiria un rol IAM propio (IRSA / EKS Pod Identity) con permisos solo
# sobre su tabla.
kubectl -n aegisvolt create secret generic aegisvolt-aws-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=test \
  --from-literal=AWS_SECRET_ACCESS_KEY=test \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

ok "Ambiente $ENV_NAME configurado (namespace aegisvolt, ConfigMap, Secret, Services)"
