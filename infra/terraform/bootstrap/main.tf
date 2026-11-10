# =============================================================================
# STACK "BOOTSTRAP" (global, se aplica UNA sola vez, no usa workspaces)
#
# Crea lo que debe existir ANTES de que los ambientes puedan desplegarse:
#   1. El bucket S3 (con versionamiento) donde vive TODO el estado de Terraform.
#   2. La tabla DynamoDB que bloquea el estado (evita dos "apply" simultaneos).
#   3. Los repositorios ECR de imagenes Docker (una imagen se construye una vez
#      y se promueve dev -> test -> prod, por eso son compartidos).
#   4. La identidad IAM "deployer" que usan el pipeline y kubectl contra EKS.
#
# Problema del huevo y la gallina: este stack crea el bucket donde se guarda su
# propio estado. scripts/bootstrap.sh lo resuelve: primer apply con estado
# local y, acto seguido, "terraform init -migrate-state" lo sube a S3
# (key bootstrap/terraform.tfstate). Al final NINGUN tfstate queda en disco.
# =============================================================================

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # El endpoint NO se escribe aqui: el provider lee la variable de entorno
  # AWS_ENDPOINT_URL (http://localhost:4566 = Floci). Sin esa variable, este
  # mismo codigo apuntaria a AWS real. Los flags de abajo solo relajan
  # validaciones que un emulador no puede responder.
  skip_credentials_validation = var.emulated
  skip_metadata_api_check     = var.emulated
  skip_requesting_account_id  = var.emulated
  s3_use_path_style           = var.emulated

  default_tags {
    tags = {
      Project   = "aegisvolt"
      ManagedBy = "terraform"
      Stack     = "bootstrap"
    }
  }
}

# ----------------------------------------------------------------------------
# 1. Bucket de estado remoto con versionamiento
# ----------------------------------------------------------------------------
resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name

  # Proteccion: "terraform destroy" no puede borrar el bucket con los estados.
  lifecycle {
    prevent_destroy = true
  }
}

# Cada escritura de terraform.tfstate crea una VERSION nueva en vez de
# sobrescribir. Asi existe un backup historico de cualquier estado.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# El estado contiene datos sensibles: nunca debe ser publico.
resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ----------------------------------------------------------------------------
# 2. Tabla de bloqueo del estado
# ----------------------------------------------------------------------------
# Terraform escribe aqui un item "LockID" mientras dura un plan/apply. Si otro
# proceso intenta operar el mismo estado, falla con "Error acquiring the state
# lock" en lugar de corromperlo.
resource "aws_dynamodb_table" "tflock" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# ----------------------------------------------------------------------------
# 3. Repositorios ECR (uno por imagen desplegable)
# ----------------------------------------------------------------------------
resource "aws_ecr_repository" "service" {
  for_each = toset(var.image_repositories)

  name                 = "aegisvolt/${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

# ----------------------------------------------------------------------------
# 4. Identidad de despliegue (CI/CD + kubectl)
# ----------------------------------------------------------------------------
# EKS autentica a kubectl con IAM: "aws eks get-token" firma una peticion STS
# con estas credenciales y el cluster la valida. Floci rechaza a proposito la
# clave publica "test/test" para este fin, igual que en AWS real nadie
# desplegaria con el usuario root.
resource "aws_iam_user" "deployer" {
  name = "aegisvolt-deployer"
  path = "/cicd/"
}

resource "aws_iam_user_policy_attachment" "deployer_admin" {
  user       = aws_iam_user.deployer.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_access_key" "deployer" {
  user = aws_iam_user.deployer.name
}
