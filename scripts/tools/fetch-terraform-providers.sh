#!/usr/bin/env bash
# =============================================================================
# Descarga el provider de Terraform a un "espejo" local (filesystem mirror).
#
# Por que existe: en algunas redes el IPv6 hacia registry.terraform.io falla y
# "terraform init" no consigue bajar el provider. Este script lo descarga por
# IPv4 una sola vez; scripts/env.sh detecta el espejo y hace que Terraform lo
# use sin tocar la red. Si su red funciona bien, este script es opcional.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

AWS_PROVIDER_VERSION="${AWS_PROVIDER_VERSION:-6.72.0}"

case "$(uname -s)" in
  MINGW*|MSYS*) os=windows ;;
  Darwin)       os=darwin ;;
  *)            os=linux ;;
esac
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  *)             arch=amd64 ;;
esac

dest="$TF_MIRROR_DIR/registry.terraform.io/hashicorp/aws"
file="terraform-provider-aws_${AWS_PROVIDER_VERSION}_${os}_${arch}.zip"
mkdir -p "$dest"

if [[ -s "$dest/$file" ]]; then
  ok "Provider ya presente en el espejo: $file"
  exit 0
fi

log "Descargando $file por IPv4 (~170 MB)"
retry curl -4 -fL --retry 5 --retry-all-errors -C - -o "$dest/$file.part" \
  "https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}/${file}"
mv "$dest/$file.part" "$dest/$file"
ok "Espejo listo en $dest"
