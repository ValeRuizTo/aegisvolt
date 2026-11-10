#!/usr/bin/env bash
# =============================================================================
# Versiones historicas del terraform.tfstate en S3 (backups) y restauracion.
#
#   scripts/demo/state-versions.sh <dev|test|prod>                 lista versiones
#   scripts/demo/state-versions.sh <dev|test|prod> restore <id>    restaura una
#
# Restaurar = copiar una version anterior ENCIMA de la actual. No se borra
# nada: la version corrupta sigue existiendo como una version mas del objeto.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

ENV_NAME="${1:-}"; ACTION="${2:-list}"; VERSION_ID="${3:-}"
require_env "$ENV_NAME"
KEY="env:/${ENV_NAME}/platform/terraform.tfstate"

if [[ "$ACTION" == "restore" ]]; then
  [[ -n "$VERSION_ID" ]] || die "Uso: state-versions.sh <ambiente> restore <VersionId>"
  log "Restaurando $KEY a la version $VERSION_ID"
  aws s3api copy-object --bucket "$TF_STATE_BUCKET" --key "$KEY" \
    --copy-source "${TF_STATE_BUCKET}/${KEY}?versionId=${VERSION_ID}" --query 'VersionId' --output text
  # Terraform guarda en DynamoDB el hash (MD5) del estado; hay que alinearlo
  # con el contenido restaurado o el siguiente comando fallara por checksum.
  digest="$(aws s3 cp "s3://${TF_STATE_BUCKET}/${KEY}" - | md5sum | cut -d' ' -f1)"
  aws dynamodb put-item --table-name aegisvolt-tflock \
    --item "{\"LockID\":{\"S\":\"${TF_STATE_BUCKET}/${KEY}-md5\"},\"Digest\":{\"S\":\"$digest\"}}"
  ok "Estado restaurado. Verifique con: scripts/tf.sh $ENV_NAME plan"
fi

log "Bucket s3://$TF_STATE_BUCKET - versionamiento: $(aws s3api get-bucket-versioning --bucket "$TF_STATE_BUCKET" --query Status --output text)"
log "Versiones de $KEY (la mas reciente primero)"
aws s3api list-object-versions --bucket "$TF_STATE_BUCKET" --prefix "$KEY" \
  --query 'reverse(sort_by(Versions, &LastModified))[].{VersionId: VersionId, Actual: IsLatest, Modificado: LastModified, Bytes: Size}' --output table
