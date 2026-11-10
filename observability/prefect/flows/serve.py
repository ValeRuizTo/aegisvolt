"""Registra el flujo de observabilidad en Prefect y lo deja programado."""

import os

from flows.observability import platform_observability

if __name__ == "__main__":
    platform_observability.serve(
        name="aegisvolt-observability",
        interval=int(os.environ.get("AUDIT_INTERVAL_SECONDS", "120")),
        tags=["aegisvolt", "observability", "saga-audit"],
        description="Salud de dev/test/prod, auditoria de SAGAs en DynamoDB y errores de CloudWatch.",
    )
