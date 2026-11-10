variable "aws_region" {
  description = "Region AWS (Floci emula us-east-1 por defecto)."
  type        = string
  default     = "us-east-1"
}

variable "emulated" {
  description = "true cuando el destino es Floci (emulador). false para AWS real."
  type        = bool
  default     = true
}

variable "state_bucket_name" {
  description = "Bucket S3 que almacena todos los terraform.tfstate del proyecto."
  type        = string
  default     = "aegisvolt-tfstate"
}

variable "lock_table_name" {
  description = "Tabla DynamoDB para el bloqueo del estado."
  type        = string
  default     = "aegisvolt-tflock"
}

variable "image_repositories" {
  description = "Imagenes Docker desplegables del proyecto."
  type        = list(string)
  default = [
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
    "graphql-gateway",
    "frontend",
  ]
}
