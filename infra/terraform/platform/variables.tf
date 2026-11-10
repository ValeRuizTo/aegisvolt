variable "aws_region" {
  description = "Region AWS."
  type        = string
  default     = "us-east-1"
}

variable "emulated" {
  description = "true cuando el destino es Floci (emulador). false para AWS real."
  type        = bool
  default     = true
}

variable "kubernetes_version" {
  description = "Version de Kubernetes del cluster EKS."
  type        = string
  default     = "1.31"
}

variable "graphql_node_port" {
  description = "NodePort del Service del GraphQL gateway (destino del API Gateway)."
  type        = number
  default     = 30080
}

variable "frontend_node_port" {
  description = "NodePort del Service del frontend (destino del API Gateway)."
  type        = number
  default     = 30081
}
