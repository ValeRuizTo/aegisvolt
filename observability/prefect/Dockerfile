# Imagen de Prefect para AegisVolt. La misma imagen sirve para el servidor
# (API + dashboard) y para el proceso que ejecuta los flujos.
FROM python:3.12-slim
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
WORKDIR /opt/aegisvolt
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY flows ./flows
# "serve" registra el deployment en el servidor de Prefect y queda a la espera
# de ejecuciones (programadas cada 2 minutos o lanzadas a mano desde la UI).
CMD ["python", "-m", "flows.serve"]
