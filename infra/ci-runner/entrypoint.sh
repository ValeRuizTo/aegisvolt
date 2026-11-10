#!/usr/bin/env bash
# Registra el runner en el repositorio (token de un solo uso) y lo ejecuta.
set -euo pipefail
cd /opt/actions-runner

if [[ ! -f .runner ]]; then
  ./config.sh --unattended --replace \
    --url "$REPO_URL" --token "$RUNNER_TOKEN" \
    --name "${RUNNER_NAME:-aegisvolt-local}" \
    --labels "${LABELS:-aegisvolt}" \
    --work "${RUNNER_WORKDIR:-/tmp/runner/work}"
fi
exec ./run.sh
