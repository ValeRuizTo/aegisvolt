#!/usr/bin/env bash
# =============================================================================
# Aplica el stack "bootstrap" (bucket de estado, tabla de lock, ECR, deployer).
# Es idempotente: se puede ejecutar las veces que haga falta.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

DIR="$REPO_ROOT/infra/terraform/bootstrap"
cd "$DIR"

if aws s3api head-bucket --bucket "$TF_STATE_BUCKET" >/dev/null 2>&1; then
  # Caso normal: el bucket ya existe, el estado ya es remoto.
  log "El bucket de estado ya existe: apply normal con backend S3"
  retry terraform init -input=false -reconfigure >/dev/null
  terraform apply -input=false -auto-approve
else
  # Primera vez: el backend S3 todavia no existe.
  log "Primer bootstrap: se crea el bucket con estado local y luego se migra a S3"
  mv backend.tf backend.tf.disabled
  trap 'mv -f "$DIR/backend.tf.disabled" "$DIR/backend.tf" 2>/dev/null || true' EXIT
  rm -rf .terraform
  retry terraform init -input=false >/dev/null
  terraform apply -input=false -auto-approve
  mv backend.tf.disabled backend.tf
  trap - EXIT
  log "Migrando el estado local al bucket S3 (bootstrap/terraform.tfstate)"
  retry terraform init -input=false -migrate-state -force-copy >/dev/null
  rm -f terraform.tfstate terraform.tfstate.backup
fi

ok "Bootstrap listo. Estado remoto en s3://$TF_STATE_BUCKET/bootstrap/terraform.tfstate"
terraform output
