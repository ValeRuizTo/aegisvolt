#!/usr/bin/env bash
# =============================================================================
# Detiene AegisVolt.
#
#   scripts/down.sh            pausa: detiene contenedores, CONSERVA todos los datos
#   scripts/down.sh --purge    borra todo (clusters, volumenes, estado de Terraform)
#
# Tras una pausa, "scripts/up.sh" lo deja todo como estaba.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

clusters="$(docker ps -a --format '{{.Names}}' | grep -E '^floci-aws-' || true)"

if [[ "${1:-}" == "--purge" ]]; then
  warn "Se eliminaran clusters, tablas, imagenes en ECR y el estado de Terraform"
  docker compose -f "$REPO_ROOT/observability/prefect/docker-compose.yml" down -v 2>/dev/null || true
  docker compose -f "$REPO_ROOT/infra/ci-runner/docker-compose.yml" down -v 2>/dev/null || true
  [[ -n "$clusters" ]] && docker rm -f $clusters >/dev/null
  docker compose -f "$REPO_ROOT/infra/floci/docker-compose.yml" down -v
  docker volume ls --format '{{.Name}}' | grep -E '^floci-aws-' | xargs -r docker volume rm >/dev/null
  docker network ls --format '{{.Name}}' | grep -E '^floci-aws-vpc-' | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -rf "$REPO_ROOT/.kube" "$REPO_ROOT"/infra/terraform/*/.terraform
  ok "Todo eliminado"
else
  docker compose -f "$REPO_ROOT/observability/prefect/docker-compose.yml" stop 2>/dev/null || true
  [[ -n "$clusters" ]] && docker stop $clusters >/dev/null
  docker compose -f "$REPO_ROOT/infra/floci/docker-compose.yml" stop
  ok "Contenedores detenidos (datos conservados). Para reanudar: scripts/up.sh"
fi
