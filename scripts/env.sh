#!/usr/bin/env bash
# =============================================================================
# Variables de entorno comunes a todos los scripts (uso:  source scripts/env.sh)
#
# Aqui se decide CONTRA QUE NUBE se trabaja. Con AWS_ENDPOINT_URL apuntando a
# Floci, tanto AWS CLI como Terraform (provider y backend S3) y los SDK hablan
# con el emulador. Quitando esa variable, el mismo codigo hablaria con AWS real.
# =============================================================================

# En Git Bash (Windows) las herramientas nativas (terraform, aws, kubectl) no
# entienden rutas "/c/Users/...": se convierten a "C:/Users/...", que funciona
# tanto en bash como en los .exe. En Linux/macOS no cambia nada.
_native_path() {
  case "$(uname -s)" in
    MINGW*|MSYS*) cygpath -m "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Dispositivo nulo para herramientas nativas (curl -o ...).
case "$(uname -s)" in
  MINGW*|MSYS*) export NULL_DEVICE="NUL" ;;
  *)            export NULL_DEVICE="/dev/null" ;;
esac

# Raiz del repositorio (este archivo vive en <raiz>/scripts).
REPO_ROOT="$(_native_path "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
export REPO_ROOT

# Git Bash en Windows convierte argumentos tipo "/aegisvolt/dev" en rutas
# "C:/Program Files/Git/aegisvolt/dev". Esto lo desactiva.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

# --- Endpoint del emulador ---------------------------------------------------
# En la maquina local: http://localhost:4566
# Dentro de la red Docker (runner de CI, Prefect): http://floci:4566
export FLOCI_ENDPOINT="${FLOCI_ENDPOINT:-http://localhost:4566}"
export AWS_ENDPOINT_URL="$FLOCI_ENDPOINT"
export AWS_ENDPOINT_URL_S3="$FLOCI_ENDPOINT"
export AWS_ENDPOINT_URL_DYNAMODB="$FLOCI_ENDPOINT"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_REGION="$AWS_DEFAULT_REGION"
export AWS_PAGER=""
export AWS_EC2_METADATA_DISABLED=true

# Credenciales "de infraestructura". En Floci cualquier par sirve para crear
# recursos; kubectl contra EKS usa en cambio la identidad "deployer"
# (ver use_deployer_credentials mas abajo).
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

# --- Constantes del proyecto -------------------------------------------------
export PROJECT="aegisvolt"
export ACCOUNT_ID="000000000000"
export TF_STATE_BUCKET="aegisvolt-tfstate"
export ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.localhost:4566"
export ENVIRONMENTS="dev test prod"
export SERVICES="station-reservation-service billing-wallet-service energy-dispatch-service graphql-gateway"
export TF_IN_AUTOMATION=1
export TF_INPUT=0
# Espejo local de providers (opcional, ver scripts/tools/fetch-terraform-providers.sh).
# Si existe, Terraform instala el provider desde disco y no necesita internet.
export TF_MIRROR_DIR="${TF_MIRROR_DIR:-$(_native_path "$HOME")/.terraform.d/aegisvolt-mirror}"
if [[ -d "$TF_MIRROR_DIR/registry.terraform.io" ]]; then
  _tfrc="$TF_MIRROR_DIR/terraform.rc"
  cat > "$_tfrc" <<TFRC
provider_installation {
  filesystem_mirror {
    path    = "$TF_MIRROR_DIR"
    include = ["registry.terraform.io/hashicorp/aws"]
  }
  direct {
    exclude = ["registry.terraform.io/hashicorp/aws"]
  }
}
TFRC
  export TF_CLI_CONFIG_FILE="$_tfrc"
fi

# IP fija de Floci en la red Docker "aegisvolt-net": la usan los pods.
export FLOCI_INTERNAL_IP="172.30.0.10"

log()  { printf '\033[1;36m[aegisvolt]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[  ok  ]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[ warn ]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error ]\033[0m %s\n' "$*" >&2; exit 1; }

# Reintenta un comando ante fallos transitorios de red (descargas).
retry() {
  local n=0 max="${RETRIES:-5}"
  until "$@"; do
    n=$((n + 1))
    [[ $n -ge $max ]] && return 1
    warn "Fallo (intento $n/$max): $*  -> reintentando en 5s"
    sleep 5
  done
}

# Valida que el argumento sea uno de los tres ambientes estaticos.
require_env() {
  case "${1:-}" in
    dev|test|prod) ;;
    *) die "Ambiente invalido '${1:-}'. Use: dev | test | prod" ;;
  esac
}

# Salida de un output de Terraform del stack bootstrap.
bootstrap_output() {
  terraform -chdir="$REPO_ROOT/infra/terraform/bootstrap" output -raw "$1" 2>/dev/null | tr -d '\r'
}

# Cambia las credenciales del shell a la identidad IAM "aegisvolt-deployer".
# Necesario antes de usar kubectl: el webhook de autenticacion de EKS valida
# el token firmado con estas claves.
use_deployer_credentials() {
  if [[ -n "${DEPLOYER_ACCESS_KEY_ID:-}" && -n "${DEPLOYER_SECRET_ACCESS_KEY:-}" ]]; then
    # En CI llegan como secretos del pipeline.
    export AWS_ACCESS_KEY_ID="$DEPLOYER_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$DEPLOYER_SECRET_ACCESS_KEY"
    return
  fi
  local id secret
  id="$(bootstrap_output deployer_access_key_id)"
  secret="$(bootstrap_output deployer_secret_access_key)"
  [[ -n "$id" && -n "$secret" ]] || die "No hay credenciales deployer. Ejecute scripts/bootstrap.sh"
  export AWS_ACCESS_KEY_ID="$id"
  export AWS_SECRET_ACCESS_KEY="$secret"
}

# Deja KUBECONFIG apuntando al cluster EKS del ambiente indicado.
use_cluster() {
  local env="$1"
  require_env "$env"
  use_deployer_credentials
  mkdir -p "$REPO_ROOT/.kube"
  export KUBECONFIG="$REPO_ROOT/.kube/config-$env"
  aws eks update-kubeconfig --name "${PROJECT}-${env}" --alias "${PROJECT}-${env}" --kubeconfig "$KUBECONFIG" >/dev/null
  # Dentro de la red Docker el API server no esta en localhost:65xx sino en el
  # contenedor k3s. El certificado se emitio para "localhost", por eso se fija
  # tls-server-name.
  if [[ "${KUBE_API_IN_NETWORK:-false}" == "true" ]]; then
    kubectl config set-cluster "arn:aws:eks:${AWS_DEFAULT_REGION}:${ACCOUNT_ID}:cluster/${PROJECT}-${env}" \
      --server="https://floci-aws-eks-${PROJECT}-${env}:6443" --tls-server-name=localhost >/dev/null
  fi
  export K8S_NAMESPACE="${PROJECT}"
}
