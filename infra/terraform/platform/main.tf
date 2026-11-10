# =============================================================================
# STACK "PLATFORM": toda la infraestructura de UN ambiente
#
# Se aplica una vez por workspace (dev, test, prod). Cada modulo recibe el
# nombre del ambiente y crea recursos con ese sufijo, de modo que los tres
# ambientes conviven en la misma cuenta sin colisiones.
#
#   network        VPC, subredes publicas/privadas, IGW, NAT, tablas de rutas
#   vpc_endpoints  Gateway (S3, DynamoDB) e Interface (APIGW, CloudWatch, ...)
#   dynamodb       Una tabla por microservicio (Database-per-Service) + flags
#   eks            Cluster de Kubernetes en las subredes privadas
#   api_gateway    REST API -> VPC Link -> NLB interno -> NodePorts del cluster
#   observability  Grupos de logs de CloudWatch /aegisvolt/<env>/<servicio>
# =============================================================================

module "network" {
  source = "./modules/network"

  name_prefix = local.name_prefix
  vpc_cidr    = local.settings.vpc_cidr
}

module "vpc_endpoints" {
  source = "./modules/vpc_endpoints"

  name_prefix            = local.name_prefix
  aws_region             = var.aws_region
  vpc_id                 = module.network.vpc_id
  vpc_cidr               = module.network.vpc_cidr
  private_subnet_ids     = module.network.private_subnet_ids
  private_route_table_id = module.network.private_route_table_id
}

module "dynamodb" {
  source = "./modules/dynamodb"

  name_prefix   = local.name_prefix
  project       = local.project
  env           = local.env
  feature_flags = local.settings.feature_flags
}

module "eks" {
  source = "./modules/eks"

  name_prefix        = local.name_prefix
  kubernetes_version = var.kubernetes_version
  vpc_id             = module.network.vpc_id
  vpc_cidr           = module.network.vpc_cidr
  private_subnet_ids = module.network.private_subnet_ids
  node_ports         = [var.graphql_node_port, var.frontend_node_port]
}

module "api_gateway" {
  source = "./modules/api_gateway"

  name_prefix         = local.name_prefix
  env                 = local.env
  vpc_id              = module.network.vpc_id
  private_subnet_ids  = module.network.private_subnet_ids
  execute_api_vpce_id = module.vpc_endpoints.execute_api_endpoint_id
  graphql_node_port   = var.graphql_node_port
  frontend_node_port  = var.frontend_node_port

  # Solo en el emulador (ver la descripcion de la variable en el modulo).
  emulated_node_host = var.emulated ? module.eks.emulated_node_host : null
}

module "observability" {
  source = "./modules/observability"

  project        = local.project
  env            = local.env
  services       = local.services
  retention_days = local.settings.log_retention_days
}
