#!/usr/bin/env bash
# =============================================================================
# Construye las imagenes Docker y las publica en ECR.
#
#   scripts/build-push.sh [VERSION]
#
# VERSION es el tag de la imagen; por defecto el SHA corto del commit actual.
# Las imagenes NO llevan el nombre del ambiente: la MISMA imagen que se probo en
# dev es la que se promueve a test y a prod ("build once, deploy many").
#
# BUILD_ONLY=true  -> construye sin publicar (lo usa el job lint-build del PR).
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VERSION="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
BUILD_ONLY="${BUILD_ONLY:-false}"
cd "$REPO_ROOT"

build() {
  local name="$1" dockerfile="$2" context="$3"
  local image="${ECR_REGISTRY}/${PROJECT}/${name}:${VERSION}"
  log "Construyendo $image"
  retry docker build --quiet --build-arg "APP_VERSION=${VERSION}" -f "$dockerfile" -t "$image" "$context" >/dev/null
  if [[ "$BUILD_ONLY" != "true" ]]; then
    retry docker push --quiet "$image" >/dev/null
    ok "Publicada  $image"
  else
    ok "Construida $image (sin publicar)"
  fi
}

for service in $SERVICES; do
  build "$service" "services/$service/Dockerfile" "."
done
build "frontend" "frontend/Dockerfile" "frontend"

echo "$VERSION"
