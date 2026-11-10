# Arquitectura de AegisVolt, capa por capa

Cada sección responde lo mismo: **qué es · para qué sirve · por qué aquí · cómo funciona · con quién
habla · qué pasa si falla · cómo comprobarlo · dónde está en el código · alternativas**.

Convención: `<env>` es `dev`, `test` o `prod`. Los comandos asumen Git Bash en la raíz del repo.
Antes de usar `aws` o `kubectl` a mano en una terminal nueva:

```bash
source scripts/env.sh        # apunta AWS CLI y Terraform a Floci
use_cluster dev              # (opcional) deja kubectl apuntando al clúster de dev
```

---

## 0. Floci: la "nube" del proyecto

- **Qué es.** Un emulador local de AWS. Un contenedor expone en `http://localhost:4566` las mismas
  APIs que AWS (S3, DynamoDB, EC2/VPC, EKS, API Gateway, CloudWatch, IAM, ECR…).
- **Por qué.** La especificación permite Floci en lugar de AWS real: cero costo y todo reproducible.
- **Cómo funciona.** AWS CLI, Terraform y los SDK aceptan un "endpoint" alternativo. La variable
  `AWS_ENDPOINT_URL` (definida en [scripts/env.sh](../scripts/env.sh)) los redirige a Floci. **El
  código Terraform no menciona a Floci**: quitando esa variable apuntaría a AWS real.
- **Lo que Floci hace "de verdad".** DynamoDB, S3 (con versiones), CloudWatch Logs/Metrics y API
  Gateway funcionan en el propio proceso. `aws_eks_cluster` arranca un contenedor **k3s** (un
  Kubernetes real) por clúster. ECR es un registro Docker real.
- **Lo que solo registra (límites honestos).** VPC, subredes, tablas de rutas, security groups,
  NAT, VPC Endpoints, NLB y VPC Link se crean, se consultan y quedan en el estado de Terraform,
  pero Floci **no enruta paquetes** a través de ellos. Consecuencias, ambas visibles en el código:
  1. La integración del API Gateway apunta al nodo del clúster y no al DNS del NLB
     (variable `emulated_node_host` en [modules/api_gateway](../infra/terraform/platform/modules/api_gateway/main.tf)).
  2. Los pods llegan a Floci por una IP fija (`172.30.0.10`), que hace el papel del DNS privado de
     un VPC Endpoint.
- **Si falla.** Nada responde. `docker ps` debe mostrar `aegisvolt-floci (healthy)`.
- **Dónde.** [infra/floci/docker-compose.yml](../infra/floci/docker-compose.yml).

---

## 1. Infraestructura como Código (30 %)

### 1.1 Dos stacks de Terraform

| Stack | Carpeta | Se aplica | Contiene |
|---|---|---|---|
| bootstrap | `infra/terraform/bootstrap` | una vez | bucket de estado versionado, tabla de lock, repos ECR, usuario IAM `aegisvolt-deployer` |
| platform | `infra/terraform/platform` | una vez **por workspace** | VPC, VPC Endpoints, DynamoDB, EKS, API Gateway, CloudWatch |

**Por qué dos.** El bucket donde vive el estado tiene que existir antes de que cualquier ambiente
pueda guardar el suyo, y no pertenece a ningún ambiente. Lo mismo las imágenes: se construyen una
vez y se promueven, así que ECR es compartido.

**El huevo y la gallina.** El bootstrap crea el bucket donde se guarda su propio estado.
[scripts/bootstrap.sh](../scripts/bootstrap.sh) lo resuelve: primer `apply` con estado local y
enseguida `terraform init -migrate-state` lo sube a `s3://aegisvolt-tfstate/bootstrap/terraform.tfstate`.
No queda ningún `.tfstate` en disco.

### 1.2 Workspaces: cómo se aíslan los ambientes

- **Qué es.** Un workspace es un estado independiente del mismo código.
- **Cómo funciona.** El backend S3 ([versions.tf](../infra/terraform/platform/versions.tf)) tiene
  `key = "platform/terraform.tfstate"` y `workspace_key_prefix = "env:"`. Terraform antepone el
  workspace a la key:

  ```
  s3://aegisvolt-tfstate/env:/dev/platform/terraform.tfstate
  s3://aegisvolt-tfstate/env:/test/platform/terraform.tfstate
  s3://aegisvolt-tfstate/env:/prod/platform/terraform.tfstate
  ```
- **Doble aislamiento.** (1) *De estado*: con el workspace `test` seleccionado Terraform solo lee y
  escribe el archivo de `test`; los recursos de `prod` no existen para él, así que no puede
  modificarlos ni destruirlos. (2) *De nombres*: en [locals.tf](../infra/terraform/platform/locals.tf)
  `env = terraform.workspace` y todo recurso se llama `aegisvolt-…-${env}`; no hay colisiones.
- **Sin `.tfvars` por ambiente.** Los ajustes de cada ambiente (CIDR, retención de logs, valor
  inicial de las flags) están en el mapa `env_settings` indexado por workspace. No es posible
  aplicar "los valores de prod" sobre `test` por error.
- **Salvaguarda.** Una `precondition` rechaza cualquier workspace que no sea `dev|test|prod`
  (por ejemplo `default`).
- **Único punto de entrada.** [scripts/tf.sh](../scripts/tf.sh) `<env> <plan|apply>` hace siempre
  `init` → `workspace select -or-create <env>` → comando. El pipeline llama a ese mismo script.
- **Comprobar.**
  ```bash
  scripts/tf.sh test workspace list        # dev, * test, prod
  aws s3 ls s3://aegisvolt-tfstate --recursive
  ```
- **Alternativa.** Una carpeta por ambiente (más explícito, pero duplica código) o Terragrunt.
  La especificación exige workspaces.

### 1.3 Estado en S3 con versionamiento y bloqueo

- **Versionamiento.** `aws_s3_bucket_versioning` en *Enabled*: cada escritura del `tfstate` crea una
  versión nueva en vez de sobrescribir. Es el backup histórico.
- **Bloqueo.** La tabla DynamoDB `aegisvolt-tflock`: durante un `plan/apply` Terraform escribe un
  item `LockID`; un segundo proceso sobre el mismo estado falla con *Error acquiring the state lock*
  en lugar de corromperlo. Guarda además el MD5 del estado.
- **Restaurar una versión.** Copiar la versión antigua encima de la actual (no se borra nada):
  ```bash
  scripts/demo/state-versions.sh dev                    # lista VersionId
  scripts/demo/state-versions.sh dev restore <VersionId>
  scripts/tf.sh dev plan                                # Terraform muestra qué difiere de la realidad
  ```
- **Protección extra.** `prevent_destroy` en el bucket y bloqueo de acceso público.

### 1.4 Red: VPC, subredes y tablas de rutas

Módulo [network](../infra/terraform/platform/modules/network/main.tf). Por ambiente:

| Elemento | dev | test | prod |
|---|---|---|---|
| VPC | 10.10.0.0/16 | 10.20.0.0/16 | 10.30.0.0/16 |
| Subredes públicas (2 AZ) | 10.10.0.0/24, 10.10.1.0/24 | 10.20.0-1.0/24 | 10.30.0-1.0/24 |
| Subredes privadas (2 AZ) | 10.10.10.0/24, 10.10.11.0/24 | 10.20.10-11.0/24 | 10.30.10-11.0/24 |

- **Pública** = su tabla de rutas tiene `0.0.0.0/0 → Internet Gateway`. Solo aloja el NAT Gateway.
- **Privada** = su tabla tiene `0.0.0.0/0 → NAT Gateway` (salida, nunca entrada). Ahí viven los nodos
  de EKS y los VPC Endpoints. Nada en ellas tiene IP pública.

### 1.5 VPC Endpoints

Módulo [vpc_endpoints](../infra/terraform/platform/modules/vpc_endpoints/main.tf).

| Tipo | Servicios | Cómo funciona | Qué lo gobierna |
|---|---|---|---|
| **Gateway** | S3, DynamoDB | No crea interfaces. Añade una ruta en la tabla **privada** con destino la *prefix list* del servicio. | Tabla de rutas + política del endpoint |
| **Interface** (PrivateLink) | `execute-api`, `logs`, `monitoring`, `ecr.api`, `ecr.dkr`, `sts`, `eks` | Crea una ENI con IP privada en cada subred privada; con DNS privado, el nombre público del servicio resuelve a esa IP. | **Security group** del endpoint (443 solo desde el CIDR de la VPC) |

**Para qué.** Sin ellos, un pod que escribe en DynamoDB saldría por NAT a internet. Con ellos, ese
tráfico nunca abandona la red privada de AWS.

### 1.6 Recorrido de un paquete: del cliente al pod

```
Cliente → API Gateway (REGIONAL, stage <env>)
        → integración HTTP_PROXY con connection_type = VPC_LINK
        → VPC Link (PrivateLink) → ENI en subred privada
        → NLB INTERNO (sin IP pública), listener TCP 30080 (GraphQL) / 30081 (frontend)
        → target group → nodo EKS : NodePort          [security group de nodos: solo esos puertos, solo desde el CIDR de la VPC]
        → kube-proxy (reglas iptables del Service)
        → Pod : 3000
```

Qué interviene: la **tabla de rutas privada** (ruta `local` dentro de la VPC), el **security group
de los nodos** ([modules/eks](../infra/terraform/platform/modules/eks/main.tf)) y, dentro del clúster,
el **Service NodePort**. El camino de salida del pod hacia DynamoDB usa el **Gateway Endpoint**
(ruta por prefix list) y hacia CloudWatch el **Interface Endpoint** `logs` (security group del endpoint).

En Floci (ver sección 0) el tramo VPC Link → NLB no transporta paquetes: el API Gateway llama al
contenedor del nodo (`floci-aws-eks-aegisvolt-<env>:30080`) por la red Docker.

### 1.7 DynamoDB: Database-per-Service

Módulo [dynamodb](../infra/terraform/platform/modules/dynamodb/main.tf). Cinco tablas por ambiente:

| Tabla | Dueño | Clave | Items |
|---|---|---|---|
| `aegisvolt-reservations-<env>` | station-reservation-service | pk/sk | `STATION#id`/`META`, `STATION#id`/`CONNECTOR#id`, `RESERVATION#sagaId`/`META` |
| `aegisvolt-billing-<env>` | billing-wallet-service | pk/sk | `WALLET#fleet`/`BALANCE`, `WALLET#fleet`/`TX#sagaId#CHARGE`, `…#REFUND` |
| `aegisvolt-dispatch-<env>` | energy-dispatch-service | pk/sk | `SESSION#sagaId`/`META`, `SESSION#sagaId`/`TELEMETRY#000123` |
| `aegisvolt-sagas-<env>` | orquestador (graphql-gateway) | pk/sk | `SAGA#sagaId`/`META` |
| `aegisvolt-feature-flags-<env>` | configuración | flag_name | una fila por flag |

- **Database-per-Service.** Ningún servicio lee la tabla de otro; se hablan por HTTP. Por eso
  una "transacción" que toca tres tablas no puede ser ACID y hace falta la SAGA.
- **Datos iniciales.** Las flags las siembra Terraform (`aws_dynamodb_table_item` con
  `ignore_changes`, para que un `apply` posterior no deshaga un cambio en caliente). Estaciones y
  billeteras las siembra cada servicio al arrancar, con escrituras condicionales (idempotente).

### 1.8 EKS

Módulo [eks](../infra/terraform/platform/modules/eks/main.tf): un clúster por ambiente
(`aegisvolt-<env>`), en las subredes privadas, con autenticación `API` (IAM).

- **Autenticación de kubectl.** `aws eks get-token` firma una petición STS con las credenciales
  del usuario IAM `aegisvolt-deployer`; el clúster valida la firma. Floci rechaza a propósito la
  clave pública `test/test`, por eso existe ese usuario (creado en el bootstrap).
- **Comprobar.** `source scripts/env.sh && use_cluster dev && kubectl get nodes`.

---

## 2. Backend, Kubernetes, GraphQL, SAGA y Feature Flags (25 %)

### 2.1 Los cuatro servicios

| Servicio | Responsabilidad | Código |
|---|---|---|
| station-reservation-service | Disponibilidad y bloqueo temporal de conectores | [src](../services/station-reservation-service/src) |
| billing-wallet-service | Fondos, cobro, reembolso, tarifas | [src](../services/billing-wallet-service/src) |
| energy-dispatch-service | Activar el cargador, telemetría | [src](../services/energy-dispatch-service/src) |
| graphql-gateway | Esquema GraphQL + orquestador SAGA | [src](../services/graphql-gateway/src) |

Todos son Node.js + Express y comparten [packages/common](../packages/common/src) (logs,
métricas, cliente DynamoDB, flags, middleware HTTP). Cada uno tiene `app.js` (rutas),
`repository.js` (DynamoDB) y `server.js` (arranque).

**Desacople.** Cada servicio tiene su imagen, su Deployment, su Service y su tabla; se despliegan
y escalan por separado. Solo el gateway conoce a los otros tres, y solo por HTTP.

### 2.2 Kubernetes

- [k8s/services.yaml](../k8s/services.yaml): namespace `aegisvolt` y los Services. Los tres
  microservicios son `ClusterIP` (inalcanzables desde fuera); `graphql-gateway` (30080) y
  `frontend` (30081) son `NodePort`, la única entrada, usada por el API Gateway.
- [k8s/microservice.yaml](../k8s/microservice.yaml): plantilla de Deployment con `readinessProbe`
  y `livenessProbe` sobre `/health`, `RollingUpdate` con `maxUnavailable: 0`, límites de recursos
  y contenedor sin root.
- **Configuración.** El ConfigMap `aegisvolt-config` se genera a partir de los *outputs* de
  Terraform del workspace ([configure-env.sh](../scripts/deploy/configure-env.sh)): un pod de `dev`
  recibe los nombres de las tablas de `dev` y no conoce otras.

### 2.3 GraphQL

- **Qué es.** Un único endpoint (`POST /graphql`) con un esquema tipado; el cliente pide
  exactamente los campos que necesita.
- **Por qué.** El frontend arma todo el tablero con **una** petición que por dentro consulta tres
  servicios (patrón *API Composition / Aggregation*).
- **Esquema.** [schema.graphql](../services/graphql-gateway/src/schema.graphql). Queries:
  `stations`, `telemetry`, `chargingSessions`, `wallets`, `quote`, `featureFlags`, `sagas`,
  `environment`… Mutations: `reserveAndCharge` (dispara la SAGA: reserva + pago + sesión),
  `stopCharging`, `compensateSaga`, `setFeatureFlag`, `topUpWallet`.
- **Resolvers.** [resolvers.js](../services/graphql-gateway/src/resolvers.js): cada uno delega en
  el servicio dueño del dato a través de [clients.js](../services/graphql-gateway/src/clients.js)
  (propaga `x-correlation-id`, timeout de 5 s, traduce errores).
- **Alternativa.** REST con un BFF; o GraphQL Federation (excesivo para tres servicios).

### 2.4 SAGA por orquestación

- **Qué es.** Una secuencia de transacciones locales; si una falla, se ejecutan transacciones
  **compensatorias** en orden inverso. Da *consistencia eventual*, no aislamiento ACID.
- **Por qué orquestación y no coreografía.** Un componente central
  ([orchestrator.js](../services/graphql-gateway/src/saga/orchestrator.js)) conoce el flujo, lo que
  hace el estado de cada transacción visible en un solo lugar (tabla `sagas`) y fácil de demostrar.
  La coreografía (eventos entre servicios) elimina ese punto central pero reparte la lógica y
  exige un bus de mensajes.
- **Definición** ([reserveAndCharge.js](../services/graphql-gateway/src/saga/reserveAndCharge.js)):

  | # | Paso | Servicio | Compensación |
  |---|---|---|---|
  | 1 | `RESERVE_CONNECTOR` → RESERVED | station | `RELEASE_CONNECTOR` → AVAILABLE |
  | 2 | `CHARGE_WALLET` → saldo −= | billing | `REFUND_WALLET` → saldo += y evento de reversión |
  | 3 | `START_CHARGING` → ACTIVE | dispatch | `STOP_CHARGING` |
  | 4 | `CONFIRM_RESERVATION` → CHARGING | station | — |

- **Fallo en el paso 3** (avería / flag): `REFUND_WALLET` y después `RELEASE_CONNECTOR`.
  **Fallo en el paso 2** (fondos): solo `RELEASE_CONNECTOR`.
- **Garantías del orquestador.**
  1. Persiste cada transición antes de continuar → si el gateway muere, la tabla muestra dónde quedó.
  2. Compensa en orden inverso y **reintenta** las compensaciones (4 intentos, espera exponencial).
  3. Distingue rechazo definitivo (402, 409, 503 con código de negocio: no se ejecutó nada) de
     fallo **ambiguo** (timeout: no se sabe). En el caso ambiguo compensa también el paso dudoso.
  4. Estados: `STARTED → COMPLETED` o `STARTED → COMPENSATING → COMPENSATED | COMPENSATION_FAILED`.
- **Recuperación.** Mutación `compensateSaga(sagaId)`: compensa una SAGA que quedó a medias.

### 2.5 Idempotencia

**Problema.** Las compensaciones se reintentan; una petición puede llegar dos veces.
**Solución.** El `sagaId` viaja en cada llamada y forma parte de la **clave** de lo que se escribe;
todas las escrituras son **condicionales** (`ConditionExpression`) y atómicas.

| Operación | Mecanismo | Efecto de la segunda vez |
|---|---|---|
| Reservar | `TransactWriteItems`: conector `status = AVAILABLE` + `Put RESERVATION#sagaId` con `attribute_not_exists` | Devuelve la reserva existente |
| Liberar | `UpdateItem` con `ConditionExpression: reservedBy = :sagaId` | No hace nada; **nunca libera la reserva de otra SAGA** |
| Cobrar | `Put TX#sagaId#CHARGE` (`attribute_not_exists`) + `balance >= :amount` en la misma transacción | No descuenta de nuevo |
| Reembolsar | `Put TX#sagaId#REFUND` (`attribute_not_exists`) + `balance += amount` en la misma transacción | La transacción se cancela: el saldo no sube dos veces |
| Activar | `Put SESSION#sagaId` con `attribute_not_exists` | Devuelve la sesión existente |
| Telemetría | clave `TELEMETRY#<nº de muestra>` | Dos réplicas no duplican muestras |
| Mutación completa | `clientRequestId` = `sagaId`; `create()` condicional | Devuelve la misma SAGA |

Código: [station repository](../services/station-reservation-service/src/repository.js),
[billing repository](../services/billing-wallet-service/src/repository.js). Probado con peticiones
duplicadas **y simultáneas** en [tests/integration](../tests/integration/services.test.js).

### 2.6 Feature Flags

- **Implementación propia en DynamoDB** ([featureFlags.js](../packages/common/src/featureFlags.js)).
- **Aislamiento por ambiente.** Una tabla por ambiente. Un servicio de `dev` solo tiene el nombre
  de la tabla de `dev` (ConfigMap). Cambiar una flag en `dev` no puede afectar a `prod`.
- **Sin redespliegue.** El valor se relee de DynamoDB con un caché de 3 s. Un cambio (UI, GraphQL
  o AWS CLI) surte efecto en ≤ 3 s sin reiniciar pods.
- **Fallo seguro.** Si no se puede leer la tabla, la flag se considera apagada.

| Flag | Dónde se evalúa | Efecto | dev / test / prod |
|---|---|---|---|
| `ENABLE_DYNAMIC_SURGE_PRICING` | billing (`pricing.js`) | Precio × 1,5 en hora pico | on / on / off |
| `ENABLE_FAST_CHARGE_BOOST` | gateway y billing | Habilita ultra-carga (+20 %) | on / on / off |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | dispatch (`app.js`) | El paso 3 falla → rollback | off / off / off |

- **Alternativas.** Unleash, Flagsmith, AWS AppConfig (más funciones: segmentación, porcentajes).
  La versión propia es suficiente y deja todo el mecanismo a la vista.

---

## 3. CI/CD, Git y Canary (25 %)

### 3.1 Ramas y promoción

`feature/*` → PR → **dev** → PR → **test** → PR → **prod**. Cada rama es un ambiente.

- **Protección** ([protect-branches.sh](../scripts/ci/protect-branches.sh)): sin force push, sin
  borrado, cambios solo por Pull Request, seis checks obligatorios, y `enforce_admins` (aplica
  también al dueño del repositorio).
- **Cadena lineal.** El job `promotion-policy` de [ci.yml](../.github/workflows/ci.yml) rechaza un
  PR cuyo origen no corresponda (`test` solo desde `dev`, `prod` solo desde `test`). Como es un
  check obligatorio, un PR `feature/x → prod` no puede fusionarse.

### 3.2 Pre-merge (ci.yml)

| Job | Qué valida |
|---|---|
| `promotion-policy` | origen/destino del PR |
| `lint-build` | ESLint, esquema GraphQL, `terraform fmt`, build de las 5 imágenes |
| `unit-tests` | lógica de negocio y compensaciones SAGA |
| `integration-tests` | tablas DynamoDB y endpoint GraphQL |
| `e2e-tests` | stack completo en contenedores, por el frontend |
| `terraform-plan` | `workspace select <rama destino>` + `plan`, adjunto como artefacto |

### 3.3 Post-merge (cd.yml)

Un merge es un `push` a la rama destino. `github.ref_name` **es** el ambiente:

```yaml
env:
  TARGET_ENV: ${{ github.ref_name }}        # dev | test | prod
run: scripts/tf.sh "$TARGET_ENV" apply      # → terraform workspace select $TARGET_ENV + apply -auto-approve
```

`terraform-apply` → `build-push` (tag = SHA corto) → `deploy-canary`.

### 3.4 Runner auto-hospedado

Los ambientes viven en Floci, en esta máquina; un runner de GitHub en la nube no los alcanza.
[infra/ci-runner](../infra/ci-runner) es un contenedor en la red `aegisvolt-net` con Terraform,
AWS CLI, kubectl y Node. Ejecuta los mismos scripts que se usan a mano.

### 3.5 Canary

[scripts/deploy/canary.sh](../scripts/deploy/canary.sh), por microservicio:

1. **Canary.** Crea `<servicio>-canary` con 1 réplica de la versión nueva junto a las 4 de
   `<servicio>-stable`. El Service selecciona solo por `app=<servicio>`, así que reparte entre los 5
   pods: **~20 % nuevo / ~80 % estable**.
2. **Análisis.** Tres condiciones sobre la versión nueva:
   - (a) pods canary *Ready* y con 0 reinicios (health checks de Kubernetes);
   - (b) ≥ 95 % de éxito en 40 peticiones dirigidas al pod canary;
   - (c) **CloudWatch**: `ErrorCount / RequestCount` con dimensión `Version=<nueva>` ≤ 5 %.
3. **Promoción** (todo cumple): rolling update del Deployment estable a la versión nueva
   (`maxUnavailable: 0`, sin caída) y se elimina el canary.
   **Rollback** (algo falla): se elimina el canary; la versión estable nunca se tocó. El script
   sale con error y el pipeline queda en rojo.

- **Por qué por réplicas.** No requiere service mesh ni ingress controller; el mecanismo es
  Kubernetes puro y se explica con `kubectl get pods`. Limitación: el porcentaje depende del número
  de réplicas (1 de 5). **Alternativas:** Argo Rollouts, Flagger, Istio (peso de tráfico exacto).
- **Las métricas** las publica cada servicio cada 10 s
  ([metrics.js](../packages/common/src/metrics.js)), namespace `AegisVolt`.

---

## 4. Observabilidad (12 %)

### 4.1 CloudWatch Logs

- **Formato.** Una línea JSON por evento: `timestamp, level, message, service, environment,
  version, track, correlation_id, saga_id` + campos del evento.
- **Destino.** `/aegisvolt/<env>/<servicio>` (grupos creados por Terraform, módulo
  [observability](../infra/terraform/platform/modules/observability/main.tf)); un stream por pod.
- **correlation_id.** El gateway lo genera (o toma de `x-correlation-id`), lo guarda en un
  `AsyncLocalStorage` ([context.js](../packages/common/src/context.js)) y lo reenvía en cada
  llamada. Los cuatro servicios escriben el mismo id para una misma SAGA. También queda en la
  tabla `sagas` y en los movimientos de billing.
- **Envío.** [logger.js](../packages/common/src/logger.js): acumula y envía en lote cada 2 s con
  `PutLogEvents`. Si CloudWatch falla, el servicio sigue: el log ya salió por stdout.
- **Alternativa.** Un agente (Fluent Bit) que lea stdout de los contenedores; desacopla la app del
  destino, a cambio de un componente más que operar.

### 4.2 Prefect

[observability.py](../observability/prefect/flows/observability.py). Flujo
`aegisvolt-platform-observability`, cada 2 minutos; un subflujo `environment-audit` por ambiente con
cuatro tasks:

| Task | Qué hace |
|---|---|
| `check_health` | Consulta el ambiente por su API Gateway → GraphQL (`environment`, flags) |
| `audit_sagas` | Lee `aegisvolt-sagas-<env>`: cuenta por estado; detecta **huérfanas** (STARTED/COMPENSATING > 120 s), `COMPENSATION_FAILED` e **inconsistencias** cruzando con billing y reservations |
| `count_error_logs` | Cuenta logs `ERROR` de los últimos 15 min en CloudWatch |
| `publish_metrics` | `PutMetricData` en `AegisVolt/Observability` |

Publica artefactos (tabla resumen y reporte Markdown) en el dashboard. Si hay hallazgos, el run
termina en **Failed** para que se vea en rojo.

---

## 5. Frontend (8 %)

React + Vite, compilado y servido por nginx ([frontend/](../frontend)).

- **Conexión por ambiente.** La URL de GraphQL es relativa a la página
  ([api.js](../frontend/src/api.js)): el frontend servido bajo `…/aegisvolt-dev/dev/` solo puede
  hablar con `…/aegisvolt-dev/dev/graphql`. La misma imagen sirve a los tres ambientes.
- **Tiempo real.** Sondeo cada 2,5 s de una única consulta. Alternativa: suscripciones GraphQL por
  WebSocket (menos latencia, más complejidad en gateway y API Gateway).
- **Paneles.** (a) electrolineras y conectores · (b) reserva y activación (dispara la SAGA y muestra
  los pasos y compensaciones) · (c) feature flags del ambiente, con interruptor · (d) historial de
  SAGAs con sus compensaciones · además cargas en curso con telemetría y billeteras.
- **Color por ambiente.** Verde `dev`, ámbar `test`, rojo `prod`.
