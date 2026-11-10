output "environment" {
  description = "Ambiente (= workspace de Terraform)."
  value       = local.env
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "vpc_cidr" {
  value = module.network.vpc_cidr
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "public_subnet_ids" {
  value = module.network.public_subnet_ids
}

output "vpc_endpoints" {
  description = "IDs de los VPC Endpoints (gateway e interface)."
  value = {
    gateway   = module.vpc_endpoints.gateway_endpoint_ids
    interface = module.vpc_endpoints.interface_endpoint_ids
  }
}

output "dynamodb_tables" {
  description = "Tablas DynamoDB del ambiente, por dominio."
  value       = module.dynamodb.table_names
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "log_group_prefix" {
  value = module.observability.log_group_prefix
}

output "api_id" {
  value = module.api_gateway.rest_api_id
}

output "api_base_url" {
  description = "URL publica del ambiente a traves del API Gateway."
  value = var.emulated ? (
    "http://localhost:4566/execute-api/${module.api_gateway.rest_api_id}/${module.api_gateway.stage_name}"
    ) : (
    "https://${module.api_gateway.rest_api_id}.execute-api.${var.aws_region}.amazonaws.com/${module.api_gateway.stage_name}"
  )
}
