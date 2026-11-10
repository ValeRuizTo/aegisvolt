# =============================================================================
# MODULO NETWORK: VPC dedicada del ambiente
#
#   VPC 10.X.0.0/16
#   ├── Subredes PUBLICAS  (10.X.0.0/24, 10.X.1.0/24)  -> ruta 0.0.0.0/0 al Internet Gateway
#   │     Aqui solo vive el NAT Gateway (salida a internet de las privadas).
#   └── Subredes PRIVADAS  (10.X.10.0/24, 10.X.11.0/24) -> ruta 0.0.0.0/0 al NAT Gateway
#         Aqui viven los nodos de EKS (los pods) y los VPC Endpoints.
#         Nada en ellas tiene IP publica: no son alcanzables desde internet.
# =============================================================================

variable "name_prefix" { type = string }
variable "vpc_cidr" { type = string }
variable "azs" {
  type    = list(string)
  default = ["us-east-1a", "us-east-1b"]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # requerido por los Interface VPC Endpoints (DNS privado)

  tags = { Name = "${var.name_prefix}-vpc" }
}

# ----------------------------------------------------------------------------
# Subredes
# ----------------------------------------------------------------------------
resource "aws_subnet" "public" {
  count = length(var.azs)

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index) # .0.0/24, .1.0/24
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${var.name_prefix}-public-${var.azs[count.index]}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count = length(var.azs)

  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10) # .10.0/24, .11.0/24
  availability_zone = var.azs[count.index]

  tags = {
    Name                              = "${var.name_prefix}-private-${var.azs[count.index]}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

# ----------------------------------------------------------------------------
# Salida a internet
# ----------------------------------------------------------------------------
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat-eip" }
}

# El NAT vive en una subred publica y da salida (solo saliente) a las privadas,
# por ejemplo para descargar imagenes. No acepta conexiones entrantes.
resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.name_prefix}-nat" }

  depends_on = [aws_internet_gateway.this]
}

# ----------------------------------------------------------------------------
# Tablas de enrutamiento
# ----------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# La tabla privada NO tiene ruta al Internet Gateway. Los Gateway VPC Endpoints
# (S3 y DynamoDB) agregan aqui sus rutas por "prefix list": ese trafico se
# queda dentro de la red de AWS aunque exista la ruta por defecto al NAT.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-rt-private" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this.id
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ----------------------------------------------------------------------------
# Outputs
# ----------------------------------------------------------------------------
output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = aws_vpc.this.cidr_block }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "private_route_table_id" { value = aws_route_table.private.id }
output "public_route_table_id" { value = aws_route_table.public.id }
