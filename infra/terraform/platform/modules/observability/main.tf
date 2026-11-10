# =============================================================================
# MODULO OBSERVABILITY: grupos de logs de CloudWatch por ambiente y servicio
#
#   /aegisvolt/<ambiente>/<microservicio>
#   ej. /aegisvolt/test/billing-wallet-service
#
# Cada microservicio escribe ahi sus logs estructurados (JSON) con
# correlation_id, ambiente y nombre del servicio. Al estar separados por
# ambiente, una busqueda en /aegisvolt/prod/... jamas mezcla trafico de dev.
# =============================================================================

variable "project" { type = string }
variable "env" { type = string }
variable "services" { type = list(string) }
variable "retention_days" { type = number }

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(var.services)

  name              = "/${var.project}/${var.env}/${each.key}"
  retention_in_days = var.retention_days

  tags = { Service = each.key }
}

# Grupo adicional para los eventos del pipeline de despliegue (canary).
resource "aws_cloudwatch_log_group" "deployments" {
  name              = "/${var.project}/${var.env}/deployments"
  retention_in_days = var.retention_days
}

output "log_group_prefix" {
  value = "/${var.project}/${var.env}"
}

output "log_group_names" {
  value = { for k, g in aws_cloudwatch_log_group.service : k => g.name }
}
