# =============================================================================
# MODULO EKS: cluster de Kubernetes del ambiente
#
# En AWS real esto crea el plano de control administrado de EKS. En Floci,
# cada aws_eks_cluster arranca un contenedor k3s (Kubernetes real) llamado
# "floci-aws-eks-<nombre>", conectado a la red Docker de la VPC.
#
# Los nodos se ubican en las subredes PRIVADAS: los pods no tienen IP publica.
# =============================================================================

variable "name_prefix" { type = string }
variable "kubernetes_version" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "node_ports" {
  description = "NodePorts que el API Gateway (via VPC Link/NLB) necesita alcanzar."
  type        = list(number)
}

# ----------------------------------------------------------------------------
# IAM: rol que asume el plano de control de EKS
# ----------------------------------------------------------------------------
data "aws_iam_policy_document" "eks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name_prefix}-eks-cluster"
  assume_role_policy = data.aws_iam_policy_document.eks_assume.json
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ----------------------------------------------------------------------------
# Security group de los nodos
# ----------------------------------------------------------------------------
# Unica puerta de entrada a los pods desde fuera del cluster: los NodePorts del
# GraphQL gateway y del frontend, y SOLO desde direcciones internas de la VPC
# (donde vive el NLB del VPC Link). No hay ninguna regla abierta a 0.0.0.0/0.
resource "aws_security_group" "nodes" {
  name        = "${var.name_prefix}-eks-nodes"
  description = "Trafico permitido hacia los nodos del cluster EKS"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = toset(var.node_ports)
    content {
      description = "NodePort ${ingress.value} desde la VPC (NLB interno)"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = [var.vpc_cidr]
    }
  }

  ingress {
    description = "Trafico entre nodos y pods del propio cluster"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    description = "Salida (via NAT o VPC Endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-eks-nodes" }
}

# ----------------------------------------------------------------------------
# Cluster
# ----------------------------------------------------------------------------
resource "aws_eks_cluster" "this" {
  name     = var.name_prefix
  role_arn = aws_iam_role.cluster.arn
  version  = var.kubernetes_version

  vpc_config {
    subnet_ids              = var.private_subnet_ids
    security_group_ids      = [aws_security_group.nodes.id]
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  # Autenticacion por IAM ("access entries"): kubectl presenta un token firmado
  # con credenciales IAM y el cluster lo valida contra STS.
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

output "cluster_name" { value = aws_eks_cluster.this.name }
output "cluster_endpoint" { value = aws_eks_cluster.this.endpoint }
output "cluster_arn" { value = aws_eks_cluster.this.arn }
output "nodes_security_group_id" { value = aws_security_group.nodes.id }

# Nombre DNS del nodo dentro de la red Docker del emulador (solo aplica a Floci).
output "emulated_node_host" { value = "floci-aws-eks-${aws_eks_cluster.this.name}" }
