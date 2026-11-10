# AegisVolt

Plataforma cloud-native de gestión de carga para flotas eléctricas y electrolineras.
Proyecto final de **Patrones Arquitectónicos Avanzados**.

Permite reservar bahías de carga, retener saldo, activar sesiones de carga y auditar telemetría,
sobre tres ambientes aislados (`dev`, `test`, `prod`), con infraestructura como código, despliegue
Canary y transacciones compensatorias (SAGA).

Toda la nube se emula en local con **Floci** (emulador de AWS): no se necesita cuenta de AWS.

## Documentación

| Documento | Para qué sirve |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Qué es cada componente, por qué existe, cómo funciona y dónde está en el código |
| [docs/GUIA-SUSTENTACION.md](docs/GUIA-SUSTENTACION.md) | Banco de preguntas del profesor con respuesta y comando de demostración |
| [docs/OPERACION.md](docs/OPERACION.md) | Levantar todo desde cero, apagar, reiniciar y resolver problemas |

## Arquitectura en una imagen

```
            Navegador
                │  HTTP
                ▼
   ┌──────────────────────────┐        Terraform (1 workspace por ambiente)
   │  API Gateway (REST)      │        crea TODO lo de este recuadro ×3:
   │  stage = dev|test|prod   │        dev, test y prod
   └────────────┬─────────────┘
                │ VPC Link  →  NLB interno (subredes privadas)
                ▼
   ┌───────────────────────────── EKS (Kubernetes) ──────────────────────────────┐
   │  frontend (nginx+React)        graphql-gateway  ← GraphQL + orquestador SAGA │
   │                                     │ HTTP interno (ClusterIP)               │
   │              ┌──────────────────────┼───────────────────────┐                │
   │              ▼                      ▼                       ▼                │
   │   station-reservation       billing-wallet          energy-dispatch          │
   └──────────────┬──────────────────────┬───────────────────────┬────────────────┘
                  │  VPC Endpoints (DynamoDB, CloudWatch)         │
                  ▼                      ▼                       ▼
        reservations-<env>        billing-<env>          dispatch-<env>     + sagas-<env>
                                                                            + feature-flags-<env>
   CloudWatch Logs /aegisvolt/<env>/<servicio>      Prefect: salud + auditoría de SAGAs
```

## Inicio rápido

Requisitos: Docker Desktop, Terraform ≥ 1.9, AWS CLI v2, kubectl, Node.js ≥ 22, Git Bash (Windows).

```bash
scripts/up.sh
```

Ese comando levanta Floci, aplica Terraform (bootstrap + los tres workspaces), construye las
imágenes, despliega los tres ambientes y arranca Prefect. Al terminar:

| Qué | URL |
|---|---|
| Frontend `dev` | http://localhost:4566/execute-api/aegisvolt-dev/dev/ |
| Frontend `test` | http://localhost:4566/execute-api/aegisvolt-test/test/ |
| Frontend `prod` | http://localhost:4566/execute-api/aegisvolt-prod/prod/ |
| GraphQL de un ambiente | `<URL del frontend>graphql` (POST) |
| Dashboard de Prefect | http://localhost:4200 |

## Estructura del repositorio

```
infra/
  floci/                 docker-compose del emulador de AWS
  terraform/bootstrap/   bucket de estado (versionado), lock, ECR, identidad deployer
  terraform/platform/    VPC, VPC Endpoints, DynamoDB, EKS, API Gateway, CloudWatch (por workspace)
  ci-runner/             runner auto-hospedado de GitHub Actions
packages/common/         logs JSON→CloudWatch, métricas, DynamoDB, feature flags, base HTTP
services/
  station-reservation-service/   disponibilidad y bloqueo temporal de conectores
  billing-wallet-service/        fondos, cobro y reembolso
  energy-dispatch-service/       activación del cargador y telemetría
  graphql-gateway/               esquema GraphQL unificado + orquestador SAGA
frontend/                React + Vite, servido por nginx
k8s/                     manifiestos (plantilla de microservicio, Services, frontend)
observability/prefect/   flujos de observabilidad y auditoría de SAGAs
scripts/                 env.sh, tf.sh, build-push.sh, deploy/, ci/, demo/
tests/                   integration/ (DynamoDB + GraphQL) y e2e/ (stack completo)
.github/workflows/       ci.yml (pre-merge) y cd.yml (post-merge)
```

## Pruebas

```bash
npm run lint               # ESLint + validación del esquema GraphQL
npm run test:unit          # 46 pruebas: SAGA, tarifas, telemetría, logs, flags
npm run test:integration   # 46 pruebas contra DynamoDB real (Floci) y el endpoint GraphQL
scripts/ci/e2e.sh          # 9 pruebas E2E con el stack completo en contenedores
```

## Estado de cada requisito

Leyenda: **Probado** = implementado y verificado con una ejecución real · **Parcial** = funciona con
una limitación del emulador que se explica.

| Requisito de la especificación | Estado | Evidencia / nota |
|---|---|---|
| Terraform en módulos, sin creación manual | Probado | 61 recursos por ambiente, 6 módulos |
| Estado remoto en S3 con versionamiento | Probado | `scripts/demo/state-versions.sh dev` |
| Workspaces `dev/test/prod` y `${terraform.workspace}` | Probado | `env:/<ws>/platform/terraform.tfstate` |
| VPC con subredes públicas y privadas por ambiente | Probado | CIDR 10.10/10.20/10.30 |
| VPC Endpoints (Gateway S3/DynamoDB, Interface APIGW/CloudWatch/…) | Parcial | Se crean y se consultan por API; Floci no enruta paquetes a través de ellos |
| API Gateway → VPC Link → NLB → pods | Parcial | Recursos creados; en Floci la integración apunta al nodo del clúster (el NLB no tiene plano de datos) |
| DynamoDB Database-per-Service por ambiente | Probado | 5 tablas × 3 ambientes |
| 3 microservicios en Docker sobre Kubernetes (EKS) | Probado | k3s real creado por `aws_eks_cluster` |
| Esquema GraphQL unificado (Queries y Mutations) | Probado | 11 queries, 5 mutations |
| SAGA con compensaciones (fallo en paso 2 y paso 3) | Probado | `scripts/demo/saga-fault.sh test` |
| Idempotencia de compensaciones | Probado | Pruebas de integración con peticiones duplicadas y concurrentes |
| Feature Flags independientes por ambiente | Probado | Una tabla por ambiente; cambio en caliente |
| Logs JSON con `correlation_id` en CloudWatch por ambiente | Probado | `scripts/demo/trace.sh` |
| Flujos de Prefect (salud, SAGAs huérfanas, métricas) | Probado | Dashboard en :4200 |
| Canary 20 % → análisis → 100 % o rollback | Probado | `scripts/deploy/canary.sh`, `scripts/demo/canary-rollback.sh` |
| Frontend conectado al GraphQL de cada ambiente | Probado | Cuatro paneles + sesiones + billeteras |
| Pipelines CI (PR) y CD (merge) | Ver [OPERACION.md](docs/OPERACION.md#github) | Requieren el repositorio en GitHub |
| Protección de ramas (sin force push ni push directo) | Ver [OPERACION.md](docs/OPERACION.md#github) | Requieren el repositorio en GitHub |
| "Tiempo real" en el frontend | Parcial | Sondeo cada 2,5 s (no WebSocket) |
