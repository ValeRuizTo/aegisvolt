#!/usr/bin/env bash
# =============================================================================
# Aplica las reglas de proteccion a las ramas dev, test y prod (GitHub API).
#
#   scripts/ci/protect-branches.sh
#
# Reglas (identicas en las tres ramas):
#   * allow_force_pushes = false      -> "git push --force" rechazado
#   * allow_deletions    = false      -> la rama no se puede borrar
#   * required_pull_request_reviews   -> todo cambio entra por Pull Request
#                                        (push directo rechazado)
#   * required_status_checks (strict) -> los 6 checks de CI en verde antes de
#                                        habilitar el boton Merge
#   * enforce_admins     = true       -> las reglas aplican TAMBIEN al dueno
#   * required_linear_history = false -> se usan merge commits para que
#                                        dev -> test -> prod compartan historial
#
# Aprobaciones requeridas = 0: es un proyecto individual (no hay un segundo
# revisor), pero el Pull Request y los checks siguen siendo obligatorios.
# =============================================================================
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../env.sh"

repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

for branch in dev test prod; do
  log "Protegiendo la rama $branch de $repo"
  gh api -X PUT "repos/${repo}/branches/${branch}/protection" \
    -H "Accept: application/vnd.github+json" --input - >/dev/null <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["promotion-policy", "lint-build", "unit-tests", "integration-tests", "e2e-tests", "terraform-plan"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": false
}
JSON
  ok "Rama $branch protegida"
done

gh api "repos/${repo}/branches/test/protection" \
  --jq '{force_push: .allow_force_pushes.enabled, borrado: .allow_deletions.enabled, admins: .enforce_admins.enabled, checks: .required_status_checks.contexts}'
