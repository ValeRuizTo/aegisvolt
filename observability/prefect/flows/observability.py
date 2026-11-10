"""
Flujos de observabilidad de AegisVolt (Prefect 3).

    platform_observability            <- flujo principal (cada 2 minutos)
      └── environment_audit(env)      <- subflujo, uno por ambiente: dev, test, prod
            ├── check_health          Task: salud del ambiente via API Gateway + GraphQL
            ├── audit_sagas           Task: consistencia de las SAGAs en DynamoDB
            ├── count_error_logs      Task: errores recientes en CloudWatch Logs
            └── publish_metrics       Task: metricas a CloudWatch + artefactos al dashboard

Que significa "auditar la consistencia" de una SAGA:
  * HUERFANA: lleva demasiado tiempo en STARTED o COMPENSATING. El orquestador
    murio a mitad de camino; puede haber un conector bloqueado o dinero retenido.
  * COMPENSATION_FAILED: el rollback no pudo completarse.
  * INCONSISTENTE: el registro de la SAGA dice una cosa y las tablas de los
    servicios otra. Por ejemplo, una SAGA "COMPENSATED" cuyo cobro no tiene
    reembolso, o cuyo conector sigue bloqueado por ella.

El flujo es de solo lectura sobre las tablas de negocio: detecta y reporta.
La correccion se hace con la mutacion GraphQL compensateSaga.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import boto3
import requests
from boto3.dynamodb.conditions import Attr, Key
from prefect import flow, get_run_logger, task
from prefect.artifacts import create_markdown_artifact, create_table_artifact
from prefect.states import Failed

ENDPOINT = os.environ.get("AWS_ENDPOINT_URL", "http://localhost:4566")
REGION = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
ENVIRONMENTS = [e.strip() for e in os.environ.get("AEGISVOLT_ENVIRONMENTS", "dev,test,prod").split(",")]
SERVICES = [
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
    "graphql-gateway",
]
# Una SAGA sana termina en menos de un segundo; pasado este tiempo es huerfana.
ORPHAN_AFTER_SECONDS = int(os.environ.get("ORPHAN_AFTER_SECONDS", "120"))
ERROR_WINDOW_MINUTES = 15


def _session() -> boto3.session.Session:
    return boto3.session.Session(region_name=REGION)


def _dynamo():
    return _session().resource("dynamodb", endpoint_url=ENDPOINT)


def _scan_all(table, **kwargs) -> list[dict]:
    items, response = [], table.scan(**kwargs)
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"], **kwargs)
        items.extend(response.get("Items", []))
    return items


# -----------------------------------------------------------------------------
# Task 1: salud del ambiente
# -----------------------------------------------------------------------------
@task(retries=2, retry_delay_seconds=5)
def check_health(env: str) -> dict:
    """Consulta el ambiente por su puerta de entrada real: API Gateway -> GraphQL."""
    logger = get_run_logger()
    url = f"{ENDPOINT}/execute-api/aegisvolt-{env}/{env}/graphql"
    query = "{ environment { name version services { name status version track } } featureFlags { name enabled } }"
    result = {"environment": env, "reachable": False, "healthy": False, "version": None, "services": [], "flags": {}}
    try:
        response = requests.post(url, json={"query": query}, timeout=10)
        response.raise_for_status()
        data = response.json()["data"]
    except Exception as exc:  # noqa: BLE001 - cualquier fallo = ambiente no alcanzable
        logger.error("Ambiente %s NO alcanzable por el API Gateway: %s", env, exc)
        result["error"] = str(exc)
        return result

    services = data["environment"]["services"]
    result.update(
        reachable=True,
        version=data["environment"]["version"],
        services=services,
        healthy=data["environment"]["name"] == env and all(s["status"] == "ok" for s in services),
        flags={f["name"]: f["enabled"] for f in data["featureFlags"]},
    )
    logger.info("Ambiente %s: saludable=%s version=%s", env, result["healthy"], result["version"])
    return result


# -----------------------------------------------------------------------------
# Task 2: auditoria de SAGAs
# -----------------------------------------------------------------------------
@task
def audit_sagas(env: str) -> dict:
    """Clasifica las SAGAs del ambiente y cruza su estado con las tablas de los servicios."""
    logger = get_run_logger()
    dynamo = _dynamo()
    sagas = _scan_all(dynamo.Table(f"aegisvolt-sagas-{env}"))
    billing = dynamo.Table(f"aegisvolt-billing-{env}")
    reservations = dynamo.Table(f"aegisvolt-reservations-{env}")
    now = datetime.now(timezone.utc)

    by_status: dict[str, int] = {}
    orphans, failed_compensations, inconsistencies = [], [], []

    for saga in sagas:
        saga_id, status = saga["sagaId"], saga["status"]
        by_status[status] = by_status.get(status, 0) + 1
        data = saga.get("input", {})

        if status in ("STARTED", "COMPENSATING"):
            updated = datetime.fromisoformat(saga["updatedAt"].replace("Z", "+00:00"))
            age = int((now - updated).total_seconds())
            if age > ORPHAN_AFTER_SECONDS:
                orphans.append({"sagaId": saga_id, "status": status, "age_seconds": age,
                                "correlationId": saga.get("correlationId")})
            continue  # en curso: todavia no se puede juzgar su consistencia

        if status == "COMPENSATION_FAILED":
            failed_compensations.append({"sagaId": saga_id, "correlationId": saga.get("correlationId")})
            continue

        # --- Cruce con billing: cobro y reembolso de esta SAGA -----------------
        movements = billing.query(
            KeyConditionExpression=Key("pk").eq(f"WALLET#{data.get('fleetId')}") & Key("sk").begins_with(f"TX#{saga_id}#")
        ).get("Items", [])
        charge = next((m for m in movements if m["type"] == "CHARGE"), None)
        refund = next((m for m in movements if m["type"] == "REFUND"), None)

        # --- Cruce con reservations: quien tiene bloqueado el conector -----------
        connector = reservations.get_item(
            Key={"pk": f"STATION#{data.get('stationId')}", "sk": f"CONNECTOR#{data.get('connectorId')}"}
        ).get("Item", {})
        locked_by_saga = connector.get("reservedBy") == saga_id

        problems = []
        if status == "COMPENSATED":
            if charge and not refund:
                problems.append("cobro sin reembolso")
            if locked_by_saga:
                problems.append("conector aun bloqueado por la SAGA")
        elif status == "COMPLETED":
            if not charge:
                problems.append("SAGA completada sin cobro registrado")
            if refund:
                problems.append("SAGA completada pero con reembolso")
        for problem in problems:
            inconsistencies.append({"sagaId": saga_id, "status": status, "problem": problem,
                                    "correlationId": saga.get("correlationId")})

    result = {
        "environment": env,
        "total": len(sagas),
        "by_status": by_status,
        "completed": by_status.get("COMPLETED", 0),
        "compensated": by_status.get("COMPENSATED", 0),
        "orphans": orphans,
        "failed_compensations": failed_compensations,
        "inconsistencies": inconsistencies,
    }
    logger.info(
        "SAGAs %s: total=%d completadas=%d compensadas=%d huerfanas=%d compensacion_fallida=%d inconsistentes=%d",
        env, result["total"], result["completed"], result["compensated"],
        len(orphans), len(failed_compensations), len(inconsistencies),
    )
    for orphan in orphans:
        logger.warning("SAGA HUERFANA en %s: %s (%s hace %ss) correlation_id=%s",
                       env, orphan["sagaId"], orphan["status"], orphan["age_seconds"], orphan["correlationId"])
    return result


# -----------------------------------------------------------------------------
# Task 3: errores recientes en CloudWatch Logs
# -----------------------------------------------------------------------------
@task
def count_error_logs(env: str) -> dict:
    """Cuenta los logs de nivel ERROR de los ultimos minutos en /aegisvolt/<env>/<servicio>."""
    logs = _session().client("logs", endpoint_url=ENDPOINT)
    start = int((datetime.now(timezone.utc) - timedelta(minutes=ERROR_WINDOW_MINUTES)).timestamp() * 1000)
    counts, samples = {}, []
    for service in SERVICES:
        try:
            events = logs.filter_log_events(
                logGroupName=f"/aegisvolt/{env}/{service}", startTime=start, filterPattern='"\\"level\\":\\"ERROR\\""'
            ).get("events", [])
        except logs.exceptions.ResourceNotFoundException:
            events = []
        errors = []
        for event in events:
            try:
                entry = json.loads(event["message"])
            except ValueError:
                continue
            if entry.get("level") == "ERROR":
                errors.append(entry)
        counts[service] = len(errors)
        samples.extend(
            {"service": service, "message": e.get("message"), "correlation_id": e.get("correlation_id")}
            for e in errors[-3:]
        )
    return {"environment": env, "window_minutes": ERROR_WINDOW_MINUTES, "by_service": counts,
            "total": sum(counts.values()), "samples": samples}


# -----------------------------------------------------------------------------
# Task 4: publicar metricas
# -----------------------------------------------------------------------------
@task
def publish_metrics(env: str, health: dict, sagas: dict, errors: dict) -> None:
    """Envia las metricas de la auditoria a CloudWatch (namespace AegisVolt/Observability)."""
    cloudwatch = _session().client("cloudwatch", endpoint_url=ENDPOINT)
    dimensions = [{"Name": "Environment", "Value": env}]
    values = {
        "EnvironmentHealthy": 1 if health["healthy"] else 0,
        "SagasTotal": sagas["total"],
        "SagasCompleted": sagas["completed"],
        "SagasCompensated": sagas["compensated"],
        "SagasOrphaned": len(sagas["orphans"]),
        "SagasCompensationFailed": len(sagas["failed_compensations"]),
        "SagasInconsistent": len(sagas["inconsistencies"]),
        "ErrorLogs": errors["total"],
    }
    cloudwatch.put_metric_data(
        Namespace="AegisVolt/Observability",
        MetricData=[{"MetricName": name, "Dimensions": dimensions, "Value": value, "Unit": "Count"}
                    for name, value in values.items()],
    )


# -----------------------------------------------------------------------------
# Subflujo por ambiente
# -----------------------------------------------------------------------------
@flow(name="environment-audit", flow_run_name="audit-{env}")
def environment_audit(env: str) -> dict:
    health = check_health(env)
    sagas = audit_sagas(env)
    errors = count_error_logs(env)
    publish_metrics(env, health, sagas, errors)

    findings = sagas["orphans"] + sagas["failed_compensations"] + sagas["inconsistencies"]
    if findings:
        create_table_artifact(
            key=f"saga-findings-{env}",
            table=[{"sagaId": f["sagaId"], "hallazgo": f.get("problem") or f.get("status") or "COMPENSATION_FAILED",
                    "correlation_id": f.get("correlationId")} for f in findings],
            description=f"SAGAs que requieren atencion en {env}",
        )
    return {"environment": env, "health": health, "sagas": sagas, "errors": errors,
            "ok": health["healthy"] and not findings}


# -----------------------------------------------------------------------------
# Flujo principal
# -----------------------------------------------------------------------------
@flow(name="aegisvolt-platform-observability", log_prints=True)
def platform_observability(environments: list[str] | None = None):
    environments = environments or ENVIRONMENTS
    reports = [environment_audit(env) for env in environments]

    rows = []
    for report in reports:
        health, sagas, errors = report["health"], report["sagas"], report["errors"]
        rows.append({
            "ambiente": report["environment"],
            "saludable": "si" if health["healthy"] else "NO",
            "version": health.get("version") or "-",
            "sagas": sagas["total"],
            "completadas": sagas["completed"],
            "compensadas": sagas["compensated"],
            "huerfanas": len(sagas["orphans"]),
            "comp. fallidas": len(sagas["failed_compensations"]),
            "inconsistentes": len(sagas["inconsistencies"]),
            f"errores ({errors['window_minutes']} min)": errors["total"],
        })
    create_table_artifact(key="platform-summary", table=rows, description="Resumen de observabilidad por ambiente")

    lines = ["# AegisVolt - reporte de observabilidad", "",
             f"Generado: {datetime.now(timezone.utc).isoformat(timespec='seconds')}", ""]
    for report in reports:
        env, health = report["environment"], report["health"]
        lines.append(f"## {env} - {'OK' if report['ok'] else 'REQUIERE ATENCION'}")
        lines.append("")
        lines.append("| Servicio | Estado | Version | Track |")
        lines.append("|---|---|---|---|")
        for service in health["services"]:
            lines.append(f"| {service['name']} | {service['status']} | {service.get('version')} | {service.get('track')} |")
        flags = ", ".join(f"`{name}`={'ON' if on else 'OFF'}" for name, on in sorted(health["flags"].items()))
        lines += ["", f"Feature flags: {flags or 'no disponibles'}", ""]
        for orphan in report["sagas"]["orphans"]:
            lines.append(f"- SAGA huerfana `{orphan['sagaId']}` ({orphan['status']}, {orphan['age_seconds']} s) "
                         f"correlation_id `{orphan['correlationId']}`")
        for item in report["sagas"]["inconsistencies"]:
            lines.append(f"- Inconsistencia `{item['sagaId']}`: {item['problem']}")
        for sample in report["errors"]["samples"]:
            lines.append(f"- Error reciente en {sample['service']}: {sample['message']} "
                         f"(correlation_id `{sample['correlation_id']}`)")
        lines.append("")
    create_markdown_artifact(key="platform-report", markdown="\n".join(lines),
                             description="Reporte detallado de observabilidad")

    unhealthy = [r["environment"] for r in reports if not r["ok"]]
    if unhealthy:
        # El run queda en rojo en el dashboard: la anomalia no pasa desapercibida.
        return Failed(message=f"Ambientes que requieren atencion: {', '.join(unhealthy)}")
    print("Todos los ambientes saludables y SAGAs consistentes")
    return rows


if __name__ == "__main__":
    platform_observability()
