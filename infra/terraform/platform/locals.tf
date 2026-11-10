# =============================================================================
# CONFIGURACION POR AMBIENTE
#
# "terraform.workspace" vale dev, test o prod segun el workspace seleccionado.
# De ese unico valor se derivan los nombres de TODOS los recursos y los ajustes
# propios de cada ambiente. No hay archivos .tfvars por ambiente: es imposible
# aplicar "la configuracion de prod" sobre el workspace de test por error.
# =============================================================================

locals {
  env         = terraform.workspace
  project     = "aegisvolt"
  name_prefix = "${local.project}-${local.env}" # ej. aegisvolt-dev

  # Ajustes que cambian entre ambientes.
  env_settings = {
    dev = {
      vpc_cidr           = "10.10.0.0/16"
      log_retention_days = 3
      feature_flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = true
        ENABLE_FAST_CHARGE_BOOST        = true
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
    test = {
      vpc_cidr           = "10.20.0.0/16"
      log_retention_days = 7
      feature_flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = true
        ENABLE_FAST_CHARGE_BOOST        = true
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
    prod = {
      vpc_cidr           = "10.30.0.0/16"
      log_retention_days = 30
      feature_flags = {
        ENABLE_DYNAMIC_SURGE_PRICING    = false
        ENABLE_FAST_CHARGE_BOOST        = false
        SIMULATE_CHARGER_HARDWARE_FAULT = false
      }
    }
  }

  settings = local.env_settings[local.env]

  # Microservicios que escriben logs en CloudWatch.
  services = [
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
    "graphql-gateway",
  ]
}

# Salvaguarda: el workspace "default" (u otro nombre) no es un ambiente valido.
# Si alguien ejecuta plan/apply sin seleccionar workspace, falla aqui en vez de
# crear recursos "aegisvolt-default".
check "workspace_valido" {
  assert {
    condition     = contains(["dev", "test", "prod"], terraform.workspace)
    error_message = "Seleccione un workspace valido: terraform workspace select dev|test|prod"
  }
}

resource "terraform_data" "workspace_guard" {
  lifecycle {
    precondition {
      condition     = contains(["dev", "test", "prod"], terraform.workspace)
      error_message = "Workspace '${terraform.workspace}' no permitido. Use dev, test o prod."
    }
  }
}
