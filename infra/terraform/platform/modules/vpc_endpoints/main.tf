# =============================================================================
# MODULO VPC ENDPOINTS: acceso PRIVADO a servicios de AWS desde la VPC
#
# Sin endpoints, un pod que llama a DynamoDB saldria por NAT -> internet ->
# endpoint publico de AWS. Con endpoints, ese trafico nunca abandona la red
# privada de AWS.
#
# Hay dos tipos:
#   * GATEWAY  (S3, DynamoDB): no crea interfaces de red. Agrega una RUTA en la
#     tabla de enrutamiento privada (destino = prefix list del servicio).
#     Interviene: la tabla de rutas + la politica del endpoint.
#   * INTERFACE (API Gateway "execute-api", CloudWatch Logs, CloudWatch
#     Monitoring, ECR, STS, EKS): crea una ENI con IP privada en cada subred
#     privada (AWS PrivateLink) y, con DNS privado, el nombre publico del
#     servicio resuelve a esa IP. Interviene: el SECURITY GROUP del endpoint.
# =============================================================================

variable "name_prefix" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "private_route_table_id" { type = string }

locals {
  gateway_services = ["s3", "dynamodb"]

  interface_services = {
    "execute-api" = "API Gateway (invocacion privada de la API)"
    "logs"        = "CloudWatch Logs"
    "monitoring"  = "CloudWatch Metrics"
    "ecr.api"     = "ECR API (autenticacion de imagenes)"
    "ecr.dkr"     = "ECR Docker (descarga de imagenes)"
    "sts"         = "STS (tokens IAM para EKS)"
    "eks"         = "API de EKS"
  }
}

# Security group de los Interface Endpoints: solo acepta HTTPS (443) y solo
# desde direcciones de la propia VPC.
resource "aws_security_group" "endpoints" {
  name        = "${var.name_prefix}-vpce"
  description = "HTTPS desde la VPC hacia los Interface VPC Endpoints"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS desde la VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-vpce" }
}

# ----------------------------------------------------------------------------
# Gateway Endpoints: S3 y DynamoDB
# ----------------------------------------------------------------------------
resource "aws_vpc_endpoint" "gateway" {
  for_each = toset(local.gateway_services)

  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [var.private_route_table_id]

  tags = { Name = "${var.name_prefix}-vpce-${each.key}" }
}

# ----------------------------------------------------------------------------
# Interface Endpoints (PrivateLink)
# ----------------------------------------------------------------------------
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true

  tags = {
    Name    = "${var.name_prefix}-vpce-${replace(each.key, ".", "-")}"
    Purpose = each.value
  }
}

output "gateway_endpoint_ids" {
  value = { for k, v in aws_vpc_endpoint.gateway : k => v.id }
}

output "interface_endpoint_ids" {
  value = { for k, v in aws_vpc_endpoint.interface : k => v.id }
}

output "execute_api_endpoint_id" {
  value = aws_vpc_endpoint.interface["execute-api"].id
}

output "endpoints_security_group_id" {
  value = aws_security_group.endpoints.id
}
