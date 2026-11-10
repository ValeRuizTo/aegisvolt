# Guía de sustentación

Cómo usarla: cada pregunta trae **la respuesta corta** (lo que se dice), **la demostración** (lo que
se ejecuta) y **el archivo** que la respalda. Las preguntas marcadas *(PDF)* son literalmente las
del banco oficial; las demás son las repreguntas más probables.

## Antes de empezar (5 minutos antes)

```bash
cd ~/Documents/Patrones/aegisvolt
scripts/up.sh                       # idempotente; deja todo arriba
source scripts/env.sh               # en CADA terminal nueva: AWS CLI -> Floci
```

Pestañas del navegador:
`dev` http://localhost:4566/execute-api/aegisvolt-dev/dev/ ·
`test` …/aegisvolt-test/test/ · `prod` …/aegisvolt-prod/prod/ · Prefect http://localhost:4200

Frase de apertura (30 segundos): *"AegisVolt son tres microservicios y un gateway GraphQL sobre
Kubernetes, uno por ambiente. Toda la infraestructura la crea Terraform con un workspace por
ambiente; el estado está en S3 versionado. Reservar y cargar es una SAGA orquestada con
compensaciones idempotentes. El despliegue es Canary con análisis de métricas de CloudWatch. La
nube es Floci, un emulador local de AWS."*

---

## 6.1 Infraestructura como Código, S3 y redes (30 %)

### *(PDF)* ¿Cómo garantiza Terraform que un `apply` en `test` no sobrescriba las tablas ni el estado de `prod`?

**Respuesta.** Por dos aislamientos independientes:

1. **De estado.** Cada workspace guarda su estado en un objeto distinto de S3
   (`env:/test/platform/terraform.tfstate` vs `env:/prod/…`). Con `test` seleccionado, Terraform solo
   conoce los recursos de ese archivo; los de `prod` no existen para él, así que no puede
   modificarlos ni destruirlos.
2. **De nombres.** Todos los recursos se nombran con `terraform.workspace`
   (`aegisvolt-billing-${env}`). Aunque quisiera, `test` crearía `aegisvolt-billing-test`, nunca
   tocaría `aegisvolt-billing-prod`.

Además no hay `.tfvars` por ambiente (la configuración sale de un mapa indexado por workspace) y el
pipeline elige el workspace a partir de la rama, no de un parámetro manual.

**Demostración.**
```bash
aws s3 ls s3://aegisvolt-tfstate --recursive          # un tfstate por ambiente
scripts/tf.sh test plan | tail -3                     # "No changes" y solo recursos *-test
scripts/tf.sh test state list | grep dynamodb_table   # ninguna tabla de prod
aws dynamodb list-tables --query 'TableNames' --output text | tr '\t' '\n' | sort
```
**Archivos.** `infra/terraform/platform/versions.tf` (backend), `locals.tf` (`env = terraform.workspace`).

### *(PDF)* Muestre las versiones anteriores del `terraform.tfstate` de `dev` y explique cómo restauraría la previa.

**Demostración.**
```bash
scripts/demo/state-versions.sh dev
# equivalente crudo:
aws s3api list-object-versions --bucket aegisvolt-tfstate --prefix "env:/dev/platform/terraform.tfstate"
```
**Respuesta.** El bucket tiene versionamiento *Enabled*: cada `apply` crea una versión nueva del
objeto. Para restaurar: (1) identifico el `VersionId` bueno; (2) lo copio encima de la versión
actual con `aws s3api copy-object --copy-source "bucket/key?versionId=…"` — no borro nada, la
versión corrupta queda en el historial; (3) actualizo el MD5 que Terraform guarda en la tabla de
lock; (4) ejecuto `terraform plan` para ver qué difiere entre ese estado y la realidad.
```bash
scripts/demo/state-versions.sh dev restore <VersionId>
scripts/tf.sh dev plan
```
> Restaurar una versión antigua hace que Terraform "olvide" recursos creados después; el `plan`
> los mostrará como pendientes de crear. Restaure la versión inmediatamente anterior y, tras la
> demostración, vuelva a la más reciente con el mismo comando.

**Repreguntas.**
- *¿Y si dos personas hacen apply a la vez?* La tabla DynamoDB `aegisvolt-tflock` bloquea el estado;
  el segundo recibe *Error acquiring the state lock*.
- *¿Dónde está el estado del bootstrap?* En el mismo bucket: `bootstrap/terraform.tfstate`
  (migrado desde local en el primer arranque).

### *(PDF)* Recorrido de un paquete desde el API Gateway hasta el pod a través del VPC Endpoint.

**Respuesta.** (Dibujarlo.)
1. El cliente llama al API Gateway, stage `<env>`.
2. La ruta `/graphql` tiene una integración `HTTP_PROXY` con `connection_type = VPC_LINK`.
3. El **VPC Link** es un endpoint de PrivateLink: entrega la petición a una interfaz de red dentro
   de las **subredes privadas** de la VPC, sin pasar por internet.
4. Llega al **NLB interno** (sin IP pública), listener TCP 30080.
5. El target group apunta al **NodePort** 30080 de los nodos de EKS. Aquí interviene el
   **security group de los nodos**: solo acepta 30080/30081 y solo desde el CIDR de la VPC.
6. En el nodo, **kube-proxy** aplica las reglas del Service `graphql-gateway` y entrega al pod (3000).

Tabla de rutas que interviene: la **privada** (ruta `local` de la VPC; no tiene ruta al Internet
Gateway). En sentido contrario, cuando el pod escribe en DynamoDB, la tabla privada tiene la ruta
del **Gateway Endpoint** (prefix list de DynamoDB) y hacia CloudWatch usa el **Interface Endpoint**
`logs`, gobernado por su security group (443 desde la VPC).

**Demostración.**
```bash
aws ec2 describe-vpc-endpoints --query 'VpcEndpoints[].[VpcEndpointType,ServiceName,VpcId]' --output table
aws ec2 describe-route-tables --filters Name=tag:Name,Values=aegisvolt-dev-rt-private \
  --query 'RouteTables[].Routes[]' --output table
aws ec2 describe-security-groups --filters Name=group-name,Values=aegisvolt-dev-eks-nodes \
  --query 'SecurityGroups[].IpPermissions[].[FromPort,ToPort,IpRanges[0].CidrIp]' --output table
aws elbv2 describe-load-balancers --query 'LoadBalancers[].[LoadBalancerName,Scheme,Type]' --output table
aws apigateway get-vpc-links --query 'items[].[name,status]' --output table
```
Asociación de los Gateway Endpoints con la tabla de rutas privada:
```bash
aws ec2 describe-vpc-endpoints --filters Name=vpc-endpoint-type,Values=Gateway   --query 'VpcEndpoints[].[ServiceName,RouteTableIds[0],VpcId]' --output table
```
(En AWS real esa asociación aparece además como una ruta con destino `pl-…` dentro de la tabla;
Floci guarda la asociación en el endpoint pero no pinta la ruta.)

**Límite que hay que decir (mejor decirlo uno que lo descubra el profesor).** Floci crea y expone
todos esos recursos, pero no transporta paquetes por el VPC Link ni el NLB. Por eso la URI de
integración, solo cuando `emulated = true`, apunta al contenedor del nodo. En AWS real esa variable
va en `null` y la URI usa el DNS del NLB: es una sola línea en
`modules/api_gateway/main.tf` (`target_host = coalesce(var.emulated_node_host, aws_lb.internal.dns_name)`).

**Repreguntas.**
- *¿Diferencia entre Gateway e Interface endpoint?* Gateway (S3, DynamoDB): una ruta en la tabla de
  rutas, sin costo por hora, sin ENI. Interface: una ENI con IP privada por subred + DNS privado,
  controlada por security group.
- *¿Por qué subredes públicas si todo es privado?* Para el NAT Gateway (salida a internet de las
  privadas, p. ej. descargar imágenes).

---

## 6.2 CI/CD, promoción y Canary (25 %)

### *(PDF)* Intente un `git push --force` o un push directo a `test` y muestre qué regla lo bloquea.

**Demostración.**
```bash
git checkout test && git commit --allow-empty -m "prueba push directo"
git push origin test              # rechazado
git push --force origin test      # rechazado
# Salida real en ambos casos:
#   remote: error: GH006: Protected branch update failed for refs/heads/test.
#   remote: - Changes must be made through a pull request.
#   remote: - 6 of 6 required status checks are expected.
#   ! [remote rejected] test -> test (protected branch hook declined)
git reset --hard origin/test && git checkout dev
gh api repos/{owner}/{repo}/branches/test/protection \
  --jq '{force_push: .allow_force_pushes.enabled, pr_obligatorio: (.required_pull_request_reviews != null), admins: .enforce_admins.enabled, checks: .required_status_checks.contexts}'
```
**Respuesta.** La protección de la rama `test`: `allow_force_pushes = false`, Pull Request
obligatorio y seis checks requeridos. `enforce_admins = true` hace que la regla aplique también a
mí como dueña del repositorio. Las tres ramas tienen la misma regla
(`scripts/ci/protect-branches.sh`).

**Repregunta.** *¿Qué impide un PR de `feature/x` directo a `prod`?* El check obligatorio
`promotion-policy` (primer job de `ci.yml`): a `prod` solo se admite origen `test`. Falla el check
→ no se habilita el Merge.

### *(PDF)* Explique en el YAML cómo se determina dinámicamente el ambiente del `terraform apply`.

**Respuesta.** (Abrir `.github/workflows/cd.yml`.) El workflow se dispara con
`on: push: branches: [dev, test, prod]`; un merge es un push a la rama destino. El nombre de esa
rama está en `github.ref_name` y lo guardo en `TARGET_ENV`. El job ejecuta
`scripts/tf.sh "$TARGET_ENV" apply`, que hace `terraform workspace select $TARGET_ENV` y
`apply -auto-approve`. No hay ningún `if` por rama ni un workflow por ambiente: el nombre de la rama
**es** el nombre del workspace. En el PR (`ci.yml`) es igual pero con `github.base_ref`, la rama
destino del PR, para el `plan`.

### *(PDF)* ¿Qué métrica o condición evalúa el Canary antes de pasar del 20 % al 100 %?

**Respuesta.** Tres condiciones, todas obligatorias (`scripts/deploy/canary.sh`, fase 2):
- **(a) Health checks:** los pods canary están *Ready* (readiness sobre `/health`) y con 0 reinicios.
- **(b) Tasa de éxito ≥ 95 %** en 40 peticiones de prueba dirigidas al pod canary.
- **(c) Métrica de CloudWatch:** `ErrorCount / RequestCount` del namespace `AegisVolt`, filtrada
  por la dimensión `Version = <versión nueva>`, debe ser **≤ 5 %**.

Si todas se cumplen, promuevo (rolling update del Deployment estable, sin caída) y elimino el
canary. Si alguna falla, elimino el canary: la versión estable nunca se tocó y vuelve a recibir el
100 %; el pipeline queda en rojo.

**Demostración del rollback automático** (≈ 1 minuto):
```bash
scripts/demo/canary-rollback.sh dev billing-wallet-service
# en otra terminal, mientras corre:
use_cluster dev && kubectl -n aegisvolt get pods -l app=billing-wallet-service -L track,version
```
Se ve: 4 pods `stable` + 1 `canary`, el reparto real (~20 %), la tasa de error ~60 % en CloudWatch
y el mensaje *ROLLBACK AUTOMATICO*. Evidencia posterior:
```bash
aws logs filter-log-events --log-group-name /aegisvolt/dev/deployments --query 'events[-3:].message' --output text
```

**Repreguntas.**
- *¿Cómo se logra el 20 % sin service mesh?* Los dos Deployments comparten la etiqueta
  `app=<servicio>`, que es el único selector del Service. Con 4 + 1 pods, 1 de cada 5 conexiones va
  al canary. (`k8s/microservice.yaml`, `k8s/services.yaml`.)
- *¿Limitación?* El porcentaje depende del número de réplicas. Para un peso exacto haría falta
  Argo Rollouts o Istio.
- *¿Por qué no hay caída al promover?* `RollingUpdate` con `maxUnavailable: 0, maxSurge: 1` y
  readiness probe: un pod viejo solo sale cuando el nuevo ya responde.

---

## 6.3 Patrones, SAGA y Feature Flags (25 %)

### *(PDF)* Active la flag de fallo en `test`, dispare la mutación y demuestre la compensación en las tablas.

**Demostración completa en un comando:**
```bash
scripts/demo/saga-fault.sh test
```
**O paso a paso (más convincente):**
```bash
# 1. Activar la flag SOLO en test
scripts/demo/set-flag.sh test SIMULATE_CHARGER_HARDWARE_FAULT true
```
2. En el frontend de `test`: aparece el aviso amarillo de inyección de fallos. Elegir un conector y
   pulsar *Reservar y activar carga*. Resultado: *Operación revertida (rollback distribuido)*, con
   "↩ compensado: saldo reembolsado" y "↩ compensado: conector liberado".
   (Por GraphQL directo:)
```bash
curl -s -X POST http://localhost:4566/execute-api/aegisvolt-test/test/graphql -H 'content-type: application/json' \
  -d '{"query":"mutation { reserveAndCharge(input:{fleetId:\"FLEET-ANDES\",stationId:\"ST-BOG-01\",connectorId:\"C3\",estimatedKwh:20}) { sagaId status correlationId failure { step code } steps { name status compensation { name status } } } }"}'
```
3. Tablas (sustituir `<SAGA>`):
```bash
# billing: el cobro y su evento de reversion
aws dynamodb query --table-name aegisvolt-billing-test \
  --key-condition-expression "pk = :p AND begins_with(sk, :s)" \
  --expression-attribute-values '{":p":{"S":"WALLET#FLEET-ANDES"},":s":{"S":"TX#<SAGA>#"}}' \
  --query 'Items[].[type.S,status.S,amount.N,reason.S]' --output table
# reservations: el conector volvio a AVAILABLE
aws dynamodb get-item --table-name aegisvolt-reservations-test \
  --key '{"pk":{"S":"STATION#ST-BOG-01"},"sk":{"S":"CONNECTOR#C3"}}' --query 'Item.[status.S,reservedBy.S]'
# sagas: el registro de la transaccion distribuida
aws dynamodb get-item --table-name aegisvolt-sagas-test \
  --key '{"pk":{"S":"SAGA#<SAGA>"},"sk":{"S":"META"}}' --query 'Item.[status.S,failure.M.step.S,failure.M.code.S]'
# 4. Apagar la flag
scripts/demo/set-flag.sh test SIMULATE_CHARGER_HARDWARE_FAULT false
```
**Qué decir.** Paso 1 reservó (RESERVED), paso 2 cobró, paso 3 falló porque dispatch leyó la flag.
El orquestador compensó en orden inverso: primero `REFUND_WALLET` (saldo restaurado + movimiento
`REFUND` con el motivo) y luego `RELEASE_CONNECTOR` (AVAILABLE). El paso 3 no se compensa porque el
servicio respondió un rechazo definitivo: no llegó a iniciar nada.

**Fallo en el paso 2 (fondos insuficientes):** en el frontend elegir la flota *Caribe Cargo (saldo
bajo)*: la SAGA falla en `CHARGE_WALLET` y solo se ejecuta `RELEASE_CONNECTOR`.

### *(PDF)* ¿Cómo evita su SAGA problemas de idempotencia si una compensación se procesa dos veces?

**Respuesta.** Con tres decisiones:
1. **Clave de idempotencia = `sagaId`.** Viaja en todas las llamadas y forma parte de la clave
   primaria de lo que cada servicio escribe (`TX#<sagaId>#REFUND`, `RESERVATION#<sagaId>`).
2. **Escrituras condicionales y atómicas en DynamoDB**, no "leer y luego escribir":
   - *Reembolso:* un `TransactWriteItems` hace `Put` del movimiento `REFUND` con
     `attribute_not_exists(pk)` **y** suma el saldo. Si el `REFUND` ya existe, la transacción entera
     se cancela: el saldo no sube dos veces. El servicio responde 200 con `alreadyRefunded: true`.
   - *Liberación:* `UpdateItem … ConditionExpression: reservedBy = :sagaId`. La segunda vez la
     condición falla y no pasa nada. Y si entre tanto otra SAGA reservó ese conector, **no se lo
     quita**.
3. **Compensar lo que no ocurrió es válido.** Reembolsar una SAGA que nunca cobró responde 200
   (`nothingToRefund`). Así el orquestador puede reintentar sin miedo, incluso tras un timeout.

**Demostración.**
```bash
npm run test:integration 2>&1 | grep -i -E "IDEMPOTENCIA|simultane"
```
Pruebas clave en `tests/integration/services.test.js`: *"procesar el reembolso dos veces no devuelve
el dinero dos veces"*, *"reembolsos simultáneos de la misma SAGA: solo uno se aplica"* (4 peticiones
en paralelo), *"una compensación duplicada no libera la reserva de OTRA saga"*.
En vivo: repetir la compensación de una SAGA ya compensada:
```bash
use_cluster test
kubectl -n aegisvolt exec deploy/graphql-gateway-stable -c app -- node -e \
 'fetch("http://billing-wallet-service:3000/charges/<SAGA>/refund",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({fleetId:"FLEET-ANDES"})}).then(r=>r.text()).then(console.log)'
# -> "refunded":false,"alreadyRefunded":true  y el saldo no cambia
```
**Archivos.** `services/billing-wallet-service/src/repository.js` (`refund`),
`services/station-reservation-service/src/repository.js` (`finish`).

**Repreguntas.**
- *¿Orquestación o coreografía? ¿Por qué?* Orquestación: un coordinador conoce el flujo; el estado
  de cada transacción está en un solo lugar y el orden de compensación es explícito. Costo: el
  orquestador es un componente más y conoce a los tres servicios.
- *¿Qué pasa si el orquestador muere a mitad?* Cada transición se persiste antes de continuar; la
  SAGA queda en `STARTED`. Prefect la detecta como huérfana y `compensateSaga` la revierte.
  ```bash
  scripts/demo/orphan-saga.sh dev            # la crea
  # lanzar el flujo en Prefect (o esperar 2 min) -> run en rojo con la SAGA huerfana
  scripts/demo/orphan-saga.sh dev recover    # COMPENSATED
  ```
- *¿Qué pasa si una compensación falla?* Se reintenta 4 veces con espera exponencial. Si se agota,
  la SAGA queda `COMPENSATION_FAILED` (las demás compensaciones sí se ejecutan) y Prefect la reporta.
- *¿La SAGA es ACID?* No. Tiene atomicidad "eventual" por compensación, pero no aislamiento: durante
  unos milisegundos el saldo estuvo descontado. Es consistencia eventual.
- *¿Y si el servicio hizo el trabajo pero el gateway recibió timeout?* Es un fallo **ambiguo**: el
  orquestador reintenta (la operación es idempotente) y, si persiste, compensa también ese paso.
- *¿Dos usuarios reservan el mismo conector a la vez?* Solo uno gana: la condición
  `status = AVAILABLE` la evalúa DynamoDB atómicamente. Hay prueba con 3 reservas simultáneas.
- *¿Qué es el "bloqueo temporal"?* `lockExpiresAt` (5 min). Una reserva que nunca se confirma deja
  de bloquear el conector al vencer.

---

## 6.4 Observabilidad y presentación (20 %)

### *(PDF)* Muestre en Prefect el flujo de observabilidad y rastree en CloudWatch el `correlation_id` de una SAGA fallida.

**Demostración.**
1. http://localhost:4200 → **Deployments** → `aegisvolt-observability` → **Run → Quick run**
   (también corre solo cada 2 min). Abrir el run: se ven el flujo principal, los tres subflujos
   `audit-dev|test|prod` y sus cuatro tasks. Pestaña **Artifacts**: tabla `platform-summary` y
   reporte `platform-report`.
   ```bash
   docker exec aegisvolt-prefect-flows prefect deployment run 'aegisvolt-platform-observability/aegisvolt-observability'
   ```
2. Tomar el `correlation_id` de la SAGA fallida (lo muestra el frontend, en el resultado y en el
   detalle del historial) y rastrearlo:
   ```bash
   scripts/demo/trace.sh test <correlation_id>
   # equivalente crudo, un grupo:
   aws logs filter-log-events --log-group-name /aegisvolt/test/billing-wallet-service \
     --filter-pattern '"<correlation_id>"' --query 'events[].message' --output text
   ```
   Salida: la línea de tiempo de los 4 servicios — reserva, cobro, **ERROR** de hardware, reembolso
   y liberación — todos con el mismo id.

**Qué decir.** El gateway genera el `correlation_id` y lo propaga en la cabecera
`x-correlation-id`; cada servicio lo guarda en un `AsyncLocalStorage` y el logger lo añade a cada
línea JSON. Los grupos de logs están separados por ambiente (`/aegisvolt/test/...`).

**Repreguntas.**
- *¿Qué detecta el flujo exactamente?* SAGAs huérfanas (STARTED/COMPENSATING > 120 s),
  `COMPENSATION_FAILED` e inconsistencias (una `COMPENSATED` con cobro sin reembolso, o cuyo conector
  sigue bloqueado; una `COMPLETED` sin cobro).
- *¿Flow vs Task?* Task = unidad de trabajo con reintentos y estado propio; Flow = orquesta tasks y
  subflujos. `check_health` tiene `retries=2`.
- *¿Dónde quedan las métricas?* En el dashboard (artefactos) y en CloudWatch, namespace
  `AegisVolt/Observability`.

### *(PDF)* Cambie una flag en `dev` sin redesplegar y muestre el cambio en el frontend de `dev` mientras `prod` queda intacto.

**Demostración.** Dos pestañas: `dev` y `prod`.
```bash
scripts/demo/set-flag.sh dev ENABLE_DYNAMIC_SURGE_PRICING false
```
En ≤ 5 s, en `dev`: el interruptor pasa a OFF y, en la cotización, *Tarifa dinámica* pasa de
"× 1.5 (hora pico)" a "no aplica" y baja el *Total a retener*. En `prod` nada cambia.
```bash
scripts/demo/set-flag.sh prod       # lista las flags de prod: intactas
kubectl -n aegisvolt get pods       # (use_cluster dev) AGE y RESTARTS sin cambios: no hubo redespliegue
scripts/demo/set-flag.sh dev ENABLE_DYNAMIC_SURGE_PRICING true   # restaurar
```
Variante más visual: `ENABLE_FAST_CHARGE_BOOST` hace aparecer/desaparecer la casilla de
ultra-carga. También se puede cambiar con el interruptor del propio frontend.

**Qué decir.** Cada ambiente tiene su tabla `aegisvolt-feature-flags-<env>`; los pods de `dev` solo
reciben el nombre de la suya (ConfigMap generado desde los outputs de Terraform). Los servicios
releen la flag con un caché de 3 s; el frontend sondea cada 2,5 s.

**Repregunta.** *¿Un `terraform apply` no devuelve la flag a su valor inicial?* No: el item tiene
`lifecycle { ignore_changes = [item] }`. Terraform define el valor inicial; el valor vivo se
gestiona en caliente.

---

## Preguntas transversales probables

| Pregunta | Respuesta corta |
|---|---|
| ¿Por qué Floci y no AWS real? | La especificación lo permite; costo cero y reproducible. El Terraform no depende de Floci: el endpoint llega por `AWS_ENDPOINT_URL`. |
| ¿Qué NO es real en la emulación? | El plano de datos de red (VPC, endpoints, NLB, VPC Link). Kubernetes, DynamoDB, S3, CloudWatch, API Gateway y ECR sí funcionan. |
| ¿Por qué un clúster por ambiente y no namespaces? | Aislamiento más fuerte y coherente con "todo lleva `${terraform.workspace}`". Cuesta más recursos. |
| ¿Dónde están las credenciales? | En Floci son `test/test` en un Secret. En AWS real: IRSA / Pod Identity, un rol por servicio con permiso solo sobre su tabla. |
| ¿Por qué la misma imagen en los tres ambientes? | *Build once, deploy many*: lo que se probó en `dev` es exactamente lo que llega a `prod`. La configuración la inyecta el ConfigMap. |
| ¿Qué es un readiness probe? | Kubernetes solo envía tráfico al pod cuando `/health` responde; es lo que hace seguro el rolling update y el canary. |
| ¿Database-per-Service qué problema trae? | No hay joins ni transacciones entre servicios → API Composition (GraphQL) para leer y SAGA para escribir. |
| ¿Por qué un runner auto-hospedado? | Los runners de GitHub en la nube no alcanzan Floci, que corre en mi máquina. |
| ¿Cómo sabe el frontend a qué ambiente hablar? | URL de GraphQL relativa a la página: servido bajo `/aegisvolt-dev/dev/` solo puede llamar a `/aegisvolt-dev/dev/graphql`. |

## Dónde está cada cosa (mapa rápido)

| Tema | Archivo |
|---|---|
| Backend S3 + workspaces | `infra/terraform/platform/versions.tf`, `locals.tf` |
| VPC / endpoints / EKS / APIGW | `infra/terraform/platform/modules/*/main.tf` |
| Orquestador SAGA | `services/graphql-gateway/src/saga/orchestrator.js` |
| Pasos y compensaciones | `services/graphql-gateway/src/saga/reserveAndCharge.js` |
| Idempotencia (reembolso) | `services/billing-wallet-service/src/repository.js` |
| Idempotencia (liberación) | `services/station-reservation-service/src/repository.js` |
| Inyección de fallo | `services/energy-dispatch-service/src/app.js` |
| Feature flags | `packages/common/src/featureFlags.js` |
| Logs + correlation_id | `packages/common/src/logger.js`, `context.js` |
| Esquema GraphQL | `services/graphql-gateway/src/schema.graphql` |
| Canary | `scripts/deploy/canary.sh`, `k8s/microservice.yaml` |
| Pipelines | `.github/workflows/ci.yml`, `cd.yml` |
| Protección de ramas | `scripts/ci/protect-branches.sh` |
| Prefect | `observability/prefect/flows/observability.py` |
