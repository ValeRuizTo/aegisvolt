# =============================================================================
# MODULO API GATEWAY: punto de entrada unico de la plataforma
#
#   Cliente ──HTTPS──► API Gateway (REST, stage = ambiente)
#                          │  integracion HTTP_PROXY con connection_type = VPC_LINK
#                          ▼
#                      VPC Link ──(AWS PrivateLink)──► NLB INTERNO (subredes privadas)
#                          ▼
#                      NodePort del nodo EKS ──► Service ──► Pod
#
# Rutas:
#   ANY /graphql        -> GraphQL gateway  (NodePort 30080)
#   ANY /               -> Frontend         (NodePort 30081)
#   ANY /{proxy+}       -> Frontend         (archivos estaticos)
#
# El NLB es "internal": no tiene IP publica. La unica forma de alcanzar los
# pods desde fuera de la VPC es atravesando el API Gateway y su VPC Link.
# =============================================================================

variable "name_prefix" { type = string }
variable "env" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "execute_api_vpce_id" { type = string }
variable "graphql_node_port" { type = number }
variable "frontend_node_port" { type = number }

variable "emulated_node_host" {
  description = <<-EOT
    Solo para Floci: nombre DNS del nodo k3s en la red Docker. El emulador
    registra el NLB y el VPC Link pero no enruta paquetes a traves de ellos, asi
    que la URI de integracion apunta directamente al nodo. En AWS real se deja
    en null y la URI usa el DNS del NLB.
  EOT
  type        = string
  default     = null
}

locals {
  backends = {
    graphql  = var.graphql_node_port
    frontend = var.frontend_node_port
  }

  # Host al que el API Gateway envia la peticion.
  target_host = coalesce(var.emulated_node_host, aws_lb.internal.dns_name)
}

# ----------------------------------------------------------------------------
# NLB interno + target groups hacia los NodePorts del cluster
# ----------------------------------------------------------------------------
resource "aws_lb" "internal" {
  name               = "${var.name_prefix}-nlb"
  load_balancer_type = "network"
  internal           = true
  subnets            = var.private_subnet_ids

  tags = { Name = "${var.name_prefix}-nlb" }
}

resource "aws_lb_target_group" "backend" {
  for_each = local.backends

  name        = "${var.name_prefix}-${each.key}"
  port        = each.value
  protocol    = "TCP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  health_check {
    protocol = "TCP"
    port     = "traffic-port"
  }
}

resource "aws_lb_listener" "backend" {
  for_each = local.backends

  load_balancer_arn = aws_lb.internal.arn
  port              = each.value
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend[each.key].arn
  }
}

# ----------------------------------------------------------------------------
# VPC Link: conecta API Gateway con el NLB privado (PrivateLink)
# ----------------------------------------------------------------------------
resource "aws_api_gateway_vpc_link" "this" {
  name        = "${var.name_prefix}-vpc-link"
  description = "Acceso privado desde API Gateway al cluster EKS de ${var.env}"
  target_arns = [aws_lb.internal.arn]
}

# ----------------------------------------------------------------------------
# REST API
# ----------------------------------------------------------------------------
resource "aws_api_gateway_rest_api" "this" {
  name        = "${var.name_prefix}-api"
  description = "AegisVolt - punto de entrada del ambiente ${var.env}"

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = {
    # Floci permite fijar el ID de la API con este tag. Asi la URL de cada
    # ambiente es estable y legible: .../execute-api/aegisvolt-dev/dev/
    "floci:override-id" = var.name_prefix
  }
}

# /graphql
resource "aws_api_gateway_resource" "graphql" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "graphql"
}

# /{proxy+}  (cualquier otra ruta)
resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "{proxy+}"
}

locals {
  routes = {
    graphql = {
      resource_id = aws_api_gateway_resource.graphql.id
      uri         = "http://${local.target_host}:${var.graphql_node_port}/graphql"
      proxy_param = false
    }
    root = {
      resource_id = aws_api_gateway_rest_api.this.root_resource_id
      uri         = "http://${local.target_host}:${var.frontend_node_port}/"
      proxy_param = false
    }
    proxy = {
      resource_id = aws_api_gateway_resource.proxy.id
      uri         = "http://${local.target_host}:${var.frontend_node_port}/{proxy}"
      proxy_param = true
    }
  }
}

resource "aws_api_gateway_method" "route" {
  for_each = local.routes

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = each.value.resource_id
  http_method   = "ANY"
  authorization = "NONE"

  request_parameters = each.value.proxy_param ? { "method.request.path.proxy" = true } : {}
}

resource "aws_api_gateway_integration" "route" {
  for_each = local.routes

  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = each.value.resource_id
  http_method             = aws_api_gateway_method.route[each.key].http_method
  type                    = "HTTP_PROXY"
  integration_http_method = "ANY"
  uri                     = each.value.uri

  # El trafico hacia el backend NO sale a internet: viaja por el VPC Link.
  connection_type = "VPC_LINK"
  connection_id   = aws_api_gateway_vpc_link.this.id

  request_parameters = each.value.proxy_param ? { "integration.request.path.proxy" = "method.request.path.proxy" } : {}
}

# ----------------------------------------------------------------------------
# Despliegue y stage (el stage lleva el nombre del ambiente)
# ----------------------------------------------------------------------------
resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  # Cualquier cambio en rutas o integraciones fuerza un nuevo despliegue.
  triggers = {
    redeploy = sha1(jsonencode({
      routes       = local.routes
      methods      = { for k, m in aws_api_gateway_method.route : k => m.id }
      integrations = { for k, i in aws_api_gateway_integration.route : k => i.id }
    }))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.route]
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.env
}

output "rest_api_id" { value = aws_api_gateway_rest_api.this.id }
output "stage_name" { value = aws_api_gateway_stage.this.stage_name }
output "vpc_link_id" { value = aws_api_gateway_vpc_link.this.id }
output "nlb_dns_name" { value = aws_lb.internal.dns_name }
output "nlb_arn" { value = aws_lb.internal.arn }
