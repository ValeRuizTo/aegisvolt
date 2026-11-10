terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.72.0"
    }
  }

  # ---------------------------------------------------------------------------
  # ESTADO REMOTO EN S3 + WORKSPACES
  #
  # Un unico bloque backend sirve a los tres ambientes. Terraform antepone
  # automaticamente "env:/<workspace>/" a la key cuando el workspace no es
  # "default", de modo que cada ambiente tiene su propio archivo de estado:
  #
  #   s3://aegisvolt-tfstate/env:/dev/platform/terraform.tfstate
  #   s3://aegisvolt-tfstate/env:/test/platform/terraform.tfstate
  #   s3://aegisvolt-tfstate/env:/prod/platform/terraform.tfstate
  #
  # "terraform workspace select test" cambia QUE archivo se lee y escribe; por
  # eso un apply en test es incapaz de tocar el estado de prod.
  # ---------------------------------------------------------------------------
  backend "s3" {
    bucket               = "aegisvolt-tfstate"
    key                  = "platform/terraform.tfstate"
    workspace_key_prefix = "env:"
    region               = "us-east-1"
    dynamodb_table       = "aegisvolt-tflock"
    encrypt              = true

    # Compatibilidad con el emulador. El endpoint llega por variables de entorno
    # AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL_DYNAMODB (scripts/env.sh).
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_region_validation      = true
  }
}

provider "aws" {
  region = var.aws_region

  # Endpoint tomado de AWS_ENDPOINT_URL (Floci). Sin ella => AWS real.
  skip_credentials_validation = var.emulated
  skip_metadata_api_check     = var.emulated
  skip_requesting_account_id  = var.emulated
  s3_use_path_style           = var.emulated

  default_tags {
    tags = {
      Project     = "aegisvolt"
      Environment = terraform.workspace
      ManagedBy   = "terraform"
    }
  }
}
