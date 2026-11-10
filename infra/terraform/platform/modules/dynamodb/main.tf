# =============================================================================
# MODULO DYNAMODB: patron Database-per-Service, separado por ambiente
#
# Cada microservicio es dueno EXCLUSIVO de su tabla; ningun servicio lee ni
# escribe la tabla de otro (solo se hablan por HTTP). Nombre de cada tabla:
#     aegisvolt-<dominio>-<ambiente>     ej. aegisvolt-billing-test
#
#   reservations   -> station-reservation-service
#   billing        -> billing-wallet-service
#   dispatch       -> energy-dispatch-service
#   sagas          -> orquestador SAGA (dentro del graphql-gateway)
#   feature-flags  -> servicio de configuracion (Feature Flags por ambiente)
#
# Todas usan clave compuesta generica pk/sk ("single-table design" por
# servicio), salvo feature-flags que tiene una clave simple.
# =============================================================================

variable "name_prefix" { type = string } # aegisvolt-dev
variable "project" { type = string }
variable "env" { type = string }
variable "feature_flags" {
  description = "Estado INICIAL de cada flag en este ambiente."
  type        = map(bool)
}

locals {
  # Tablas con clave pk (hash) + sk (range).
  service_tables = ["reservations", "billing", "dispatch", "sagas"]

  flag_descriptions = {
    ENABLE_DYNAMIC_SURGE_PRICING    = "Activa tarifas dinamicas (recargo) en horas pico."
    ENABLE_FAST_CHARGE_BOOST        = "Habilita la reserva prioritaria de ultra-carga."
    SIMULATE_CHARGER_HARDWARE_FAULT = "Inyeccion de fallos: el cargador reporta averia fisica (dispara el rollback de la SAGA)."
  }
}

resource "aws_dynamodb_table" "service" {
  for_each = toset(local.service_tables)

  name         = "${var.project}-${each.key}-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  # Backups continuos: permite restaurar la tabla a cualquier segundo.
  point_in_time_recovery {
    enabled = true
  }

  tags = { Domain = each.key }
}

resource "aws_dynamodb_table" "feature_flags" {
  name         = "${var.project}-feature-flags-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "flag_name"

  attribute {
    name = "flag_name"
    type = "S"
  }

  tags = { Domain = "feature-flags" }
}

# ----------------------------------------------------------------------------
# Estado inicial de las Feature Flags del ambiente
# ----------------------------------------------------------------------------
# Terraform declara el valor INICIAL. Despues la flag se cambia en caliente
# (UI, GraphQL o AWS CLI) y "ignore_changes" evita que el siguiente
# "terraform apply" la devuelva a su valor inicial.
resource "aws_dynamodb_table_item" "flag" {
  for_each = var.feature_flags

  table_name = aws_dynamodb_table.feature_flags.name
  hash_key   = aws_dynamodb_table.feature_flags.hash_key

  item = jsonencode({
    flag_name   = { S = each.key }
    enabled     = { BOOL = each.value }
    description = { S = local.flag_descriptions[each.key] }
    environment = { S = var.env }
    updated_at  = { S = "terraform-seed" }
    updated_by  = { S = "terraform" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

output "table_names" {
  description = "Nombre real de cada tabla, indexado por dominio."
  value = merge(
    { for k, t in aws_dynamodb_table.service : k => t.name },
    { "feature-flags" = aws_dynamodb_table.feature_flags.name },
  )
}

output "table_arns" {
  value = merge(
    { for k, t in aws_dynamodb_table.service : k => t.arn },
    { "feature-flags" = aws_dynamodb_table.feature_flags.arn },
  )
}
