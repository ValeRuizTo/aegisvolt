# Estado remoto del propio stack bootstrap.
# (scripts/bootstrap.sh aparta este archivo solo durante el primer apply,
#  cuando el bucket aun no existe, y luego migra el estado local a S3.)
terraform {
  backend "s3" {
    bucket         = "aegisvolt-tfstate"
    key            = "bootstrap/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "aegisvolt-tflock"
    encrypt        = true

    # Compatibilidad con el emulador. El endpoint se toma de las variables de
    # entorno AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL_DYNAMODB (scripts/env.sh).
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_requesting_account_id  = true
    skip_region_validation      = true
  }
}
