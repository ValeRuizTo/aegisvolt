#!/usr/bin/env bash
# =============================================================================
# Levanta AegisVolt completo desde cero (idempotente: se puede repetir).
#
#   scripts/up.sh                 todo: Floci + infraestructura + 3 ambientes + Prefect
#   ENVS="dev" scripts/up.sh      solo algunos ambientes
#
# Si Floci ya tiene estado (volumen aegisvolt-floci-data), Terraform no recrea
# nada y los despliegues solo actualizan lo que cambio.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ENVS="${ENVS:-$ENVIRONMENTS}"

log "1/6 Emulador de AWS (Floci)"
retry docker compose -f "$REPO_ROOT/infra/floci/docker-compose.yml" up -d
until curl -s -m 3 "$FLOCI_ENDPOINT/_floci/health" >"$NULL_DEVICE" 2>&1; do sleep 2; done
ok "Floci responde en $FLOCI_ENDPOINT"

log "2/6 Bootstrap: bucket de estado, lock, ECR, identidad deployer"
"$REPO_ROOT/scripts/bootstrap.sh" >/dev/null

log "3/6 Infraestructura de cada ambiente (terraform workspace + apply)"
for env in $ENVS; do
  "$REPO_ROOT/scripts/tf.sh" "$env" apply | grep -E 'Apply complete|No changes' || true
done

log "4/6 Imagenes Docker -> ECR"
VERSION="$("$REPO_ROOT/scripts/build-push.sh" | tail -1)"

log "5/6 Despliegue de la version $VERSION"
for env in $ENVS; do
  "$REPO_ROOT/scripts/deploy/deploy.sh" "$env" "$VERSION"
done

log "6/6 Prefect (servidor + flujos de observabilidad)"
retry docker compose -f "$REPO_ROOT/observability/prefect/docker-compose.yml" up -d --build >/dev/null 2>&1 \
  || warn "Prefect no pudo iniciar (reintente: docker compose -f observability/prefect/docker-compose.yml up -d --build)"

echo
ok "AegisVolt en ejecucion"
for env in $ENVS; do echo "   $env  ->  $FLOCI_ENDPOINT/execute-api/${PROJECT}-${env}/${env}/"; done
echo "   Prefect ->  http://localhost:4200"
