#!/usr/bin/env bash
# =============================================================================
# Construye las imagenes Docker y las publica en ECR.
#
#   scripts/build-push.sh [VERSION]
#
# VERSION es el tag de la imagen. Por defecto es el hash del ARBOL de archivos
# del commit (git rev-parse HEAD^{tree}), no el del commit: al promover
# dev -> test -> prod cada rama tiene un merge commit distinto, pero el
# contenido es identico, asi que el tag es el mismo en los tres ambientes.
#
# "Build once, deploy many": si la imagen con ese tag ya esta en ECR (se
# construyo al desplegar en dev) NO se vuelve a construir; test y prod reciben
# exactamente los mismos bytes que se probaron en dev.
#
# BUILD_ONLY=true  -> construye sin publicar (lo usa el job lint-build del PR).
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

VERSION="${1:-$(git -C "$REPO_ROOT" rev-parse --short=7 'HEAD^{tree}' 2>/dev/null || date +%Y%m%d%H%M%S)}"
BUILD_ONLY="${BUILD_ONLY:-false}"
cd "$REPO_ROOT"

build() {
  local name="$1" dockerfile="$2" context="$3"
  local image="${ECR_REGISTRY}/${PROJECT}/${name}:${VERSION}"
  if [[ "$BUILD_ONLY" != "true" ]] && aws ecr describe-images --repository-name "${PROJECT}/${name}"        --image-ids "imageTag=${VERSION}" >/dev/null 2>&1; then
    ok "Ya existe  $image (se reutiliza, no se reconstruye)"
    return
  fi
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
