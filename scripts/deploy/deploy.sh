#!/usr/bin/env bash
# =============================================================================
# Despliega una version en un ambiente.
#
#   scripts/deploy/deploy.sh <dev|test|prod> <version>
#
#   1. Configura el cluster del ambiente (ConfigMap desde outputs de Terraform).
#   2. Canary deployment de cada microservicio (scripts/deploy/canary.sh).
#   3. Rolling update del frontend.
#   4. Prueba de humo a traves del API Gateway del ambiente.
#
# Si el canary de un servicio falla, el script se detiene: los servicios ya
# promovidos quedan en la version nueva (son compatibles hacia atras) y el
# fallido permanece en su version estable.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"
VERSION="${2:-}"
require_env "$ENV_NAME"
[[ -n "$VERSION" ]] || die "Uso: deploy.sh <ambiente> <version>"

log "===== Despliegue de la version $VERSION en el ambiente $ENV_NAME ====="
"$REPO_ROOT/scripts/deploy/configure-env.sh" "$ENV_NAME"

# Los microservicios de dominio primero; el gateway (que depende de ellos) al final.
for service in station-reservation-service billing-wallet-service energy-dispatch-service graphql-gateway; do
  "$REPO_ROOT/scripts/deploy/canary.sh" "$ENV_NAME" "$service" "$VERSION"
done

use_cluster "$ENV_NAME"
log "[$ENV_NAME/frontend] rolling update a la version $VERSION"
IMAGE="${ECR_REGISTRY}/${PROJECT}/frontend:${VERSION}" VERSION="$VERSION" \
  envsubst '${IMAGE} ${VERSION}' <"$REPO_ROOT/k8s/frontend.yaml" | kubectl apply -f - >/dev/null
kubectl -n aegisvolt rollout status deployment/frontend --timeout=240s >/dev/null \
  || die "[$ENV_NAME/frontend] el despliegue no quedo listo"
ok "[$ENV_NAME/frontend] version $VERSION desplegada"

"$REPO_ROOT/scripts/smoke-test.sh" "$ENV_NAME"
ok "===== Ambiente $ENV_NAME en la version $VERSION ====="
