#!/usr/bin/env bash
# =============================================================================
# Envoltorio de Terraform para el stack "platform".
#
#   scripts/tf.sh <dev|test|prod> <plan|apply|destroy|output|...> [args]
#
# Hace siempre lo mismo, en este orden:
#   1. terraform init            (backend S3 remoto)
#   2. terraform workspace select <ambiente>   (lo crea si no existe)
#   3. el comando pedido
#
# El pipeline de CI/CD llama a este mismo script, pasando como ambiente el
# nombre de la rama destino. No existe otra forma de elegir el ambiente.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

ENV_NAME="${1:-}"
require_env "$ENV_NAME"
shift
CMD="${1:-plan}"
shift || true

cd "$REPO_ROOT/infra/terraform/platform"

retry terraform init -input=false >/dev/null

# -or-create: si el workspace no existe todavia, lo crea.
terraform workspace select -or-create "$ENV_NAME" >/dev/null
log "Workspace activo: $(terraform workspace show)  ->  estado en s3://$TF_STATE_BUCKET/env:/$ENV_NAME/platform/terraform.tfstate"

case "$CMD" in
  plan)
    terraform plan -input=false -lock-timeout=120s "$@"
    ;;
  apply)
    terraform apply -input=false -auto-approve -lock-timeout=120s "$@"
    ;;
  destroy)
    terraform destroy -input=false -auto-approve -lock-timeout=120s "$@"
    ;;
  *)
    terraform "$CMD" "$@"
    ;;
esac
