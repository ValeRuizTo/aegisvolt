#!/usr/bin/env bash
# =============================================================================
# Registra y arranca el runner auto-hospedado de GitHub Actions.
#
#   scripts/ci/start-runner.sh
#
# Requiere haber iniciado sesion con GitHub CLI (gh auth login) y que el
# repositorio tenga un remoto "origin" en GitHub.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

command -v gh >/dev/null || die "Falta GitHub CLI (gh)"
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
[[ -n "$repo" ]] || die "No se pudo determinar el repositorio de GitHub"

log "Solicitando token de registro del runner para $repo"
export RUNNER_TOKEN="$(gh api -X POST "repos/${repo}/actions/runners/registration-token" --jq .token)"
export GITHUB_REPO_URL="https://github.com/${repo}"

retry docker compose -f "$REPO_ROOT/infra/ci-runner/docker-compose.yml" up -d --build
ok "Runner iniciado. Verifique en https://github.com/${repo}/settings/actions/runners"
