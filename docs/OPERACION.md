# Operación: levantar, apagar, GitHub y solución de problemas

Todos los comandos se ejecutan en **Git Bash**, desde la raíz del repositorio.

## Requisitos

| Herramienta | Versión usada | Para qué |
|---|---|---|
| Docker Desktop | 29.x (≥ 12 GB de RAM asignados) | Floci, clústeres k3s, Prefect, runner |
| Terraform | 1.16 | Infraestructura |
| AWS CLI | v2 | Hablar con Floci, tokens de EKS |
| kubectl | 1.31+ | Despliegues |
| Node.js | 22+ | Servicios, pruebas, utilidades de los scripts |
| GitHub CLI (`gh`) | 2.x | Repositorio, runner y protección de ramas |

## Levantar todo

```bash
scripts/up.sh
```

Es idempotente. La primera vez tarda ~15 minutos (crea 3 clústeres y construye imágenes); las
siguientes, 2–3 minutos. Pasos internos: Floci → bootstrap → `terraform apply` por workspace →
build y push de imágenes → despliegue de cada ambiente → Prefect.

Solo un ambiente: `ENVS="dev" scripts/up.sh`.

## Apagar y reanudar

```bash
scripts/down.sh            # pausa: detiene contenedores, conserva TODO
scripts/up.sh              # reanuda
scripts/down.sh --purge    # borra todo (clústeres, tablas, estado). Empezar de cero.
```

**Tras reiniciar el computador:** abrir Docker Desktop y esperar a que arranque. Floci y Prefect
tienen `restart: unless-stopped` y Floci vuelve a iniciar los clústeres; en ~1 minuto los pods están
listos. Verificar con `scripts/smoke-test.sh dev` (y `test`, `prod`). Si algo no responde:
`scripts/up.sh`.

## Operaciones del día a día

```bash
source scripts/env.sh                      # en cada terminal nueva
use_cluster dev                            # kubectl -> clúster de dev
kubectl -n aegisvolt get pods -L track,version

scripts/tf.sh test plan                    # Terraform sobre un workspace
scripts/build-push.sh v1.2.0               # construir y publicar imágenes
scripts/deploy/deploy.sh dev v1.2.0        # desplegar (canary por servicio)
scripts/deploy/canary.sh dev billing-wallet-service v1.2.0   # un solo servicio
scripts/smoke-test.sh prod                 # prueba de humo por el API Gateway
```

Demostraciones: ver [GUIA-SUSTENTACION.md](GUIA-SUSTENTACION.md) y `scripts/demo/`.

<a id="github"></a>
## GitHub: repositorio, runner, protección de ramas y pipelines

Esta parte necesita una cuenta de GitHub (única acción manual: iniciar sesión).

```bash
# 1. Iniciar sesión (abre el navegador; elegir GitHub.com -> HTTPS -> Login with a web browser)
gh auth login

# 2. Crear el repositorio y subir las tres ramas (dev es la rama por defecto)
gh repo create aegisvolt --public --source . --remote origin
git push -u origin dev
git branch test dev && git branch prod dev
git push origin test prod
gh repo edit --default-branch dev

# 3. Credenciales del deployer como secretos del repositorio (las usa el job deploy-canary)
gh secret set DEPLOYER_ACCESS_KEY_ID --body "$(terraform -chdir=infra/terraform/bootstrap output -raw deployer_access_key_id)"
gh secret set DEPLOYER_SECRET_ACCESS_KEY --body "$(terraform -chdir=infra/terraform/bootstrap output -raw deployer_secret_access_key)"

# 4. Runner auto-hospedado (contenedor en la red de Floci)
scripts/ci/start-runner.sh

# 5. Reglas de protección de dev, test y prod
scripts/ci/protect-branches.sh
```

> **Repositorio público.** En cuentas gratuitas de GitHub la protección de ramas solo se aplica en
> repositorios públicos. Las credenciales que hay en el código (`test/test`) son las de un emulador
> local y no dan acceso a nada real.

### Flujo de promoción

```bash
git checkout dev && git pull
git checkout -b feature/mi-cambio
# ... cambios ...
git commit -am "feat: mi cambio" && git push -u origin feature/mi-cambio
gh pr create --base dev  --head feature/mi-cambio --fill     # CI: 6 checks
gh pr merge --merge --delete-branch                           # CD: apply + canary en dev
gh pr create --base test --head dev  --title "Promote dev -> test"  --body "Promoción"
gh pr merge --merge                                           # CD en test
gh pr create --base prod --head test --title "Promote test -> prod" --body "Promoción"
gh pr merge --merge                                           # CD en prod
```

Se usan *merge commits* (no squash) para que `dev`, `test` y `prod` compartan historial y las
promociones no generen conflictos.

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `aws …` responde *Could not connect* | Terminal sin `source scripts/env.sh`, o Floci detenido | `source scripts/env.sh`; `docker start aegisvolt-floci` |
| `kubectl`: *You must be logged in* | Credenciales `test/test` en vez del deployer | `use_cluster <env>` |
| El frontend carga pero dice "sin conexión" | Pods aún iniciando tras un reinicio | Esperar 1 min; `kubectl -n aegisvolt get pods` |
| API Gateway responde 502 | El Service o los pods del ambiente no están | `scripts/deploy/deploy.sh <env> <version>` |
| `terraform init` no descarga el provider | Red con IPv6 defectuoso | `scripts/tools/fetch-terraform-providers.sh` (espejo local por IPv4) |
| `docker pull/build` falla con `EOF` | Cortes de red hacia Docker Hub | Reintentar; los scripts ya reintentan 5 veces |
| *Error acquiring the state lock* | Un `apply` anterior se interrumpió | `scripts/tf.sh <env> force-unlock <ID>` |
| Un job del pipeline queda *Queued* | El runner no está en línea | `docker logs aegisvolt-ci-runner`; `scripts/ci/start-runner.sh` |
| Prefect no muestra ejecuciones | Contenedor de flujos detenido | `docker compose -f observability/prefect/docker-compose.yml up -d` |
| Curl a `/dev/null` falla en Git Bash | Conversión de rutas desactivada por `env.sh` | Usar `-o NUL` (los scripts usan `$NULL_DEVICE`) |

## Reiniciar los datos de demostración de un ambiente

Los servicios siembran estaciones y billeteras al arrancar **solo si no existen**. Para volver al
estado inicial de un ambiente (conectores libres, saldos originales, sin historial):

```bash
scripts/demo/reset-data.sh dev
```
