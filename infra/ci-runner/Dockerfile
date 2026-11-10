# =============================================================================
# Runner auto-hospedado de GitHub Actions para AegisVolt
#
# Por que auto-hospedado: los ambientes viven en Floci, en esta maquina. Un
# runner de GitHub en la nube no puede alcanzar http://floci:4566 ni los
# clusters. Este contenedor se une a la red Docker "aegisvolt-net" y trae
# instaladas las herramientas que usan los pipelines.
#
# Base Debian (python:3.12-slim, la misma de la imagen de Prefect) + el agente
# oficial "actions/runner" descargado de GitHub.
# =============================================================================
FROM python:3.12-slim

ARG RUNNER_VERSION=2.338.2
ARG TERRAFORM_VERSION=1.16.2
ARG KUBECTL_VERSION=v1.31.5
ARG DOCKER_VERSION=28.5.2
ARG COMPOSE_VERSION=v2.40.3
ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive RUNNER_ALLOW_RUNASROOT=1

RUN apt-get update  && apt-get install -y --no-install-recommends curl ca-certificates git unzip gettext-base gawk jq xz-utils  && rm -rf /var/lib/apt/lists/*

# Agente de GitHub Actions
RUN mkdir -p /opt/actions-runner && cd /opt/actions-runner  && curl -fsSL --retry 5 --retry-all-errors -o runner.tgz       https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz  && tar xzf runner.tgz && rm runner.tgz  && ./bin/installdependencies.sh && rm -rf /var/lib/apt/lists/*

# Cliente Docker + plugin compose (el daemon es el del host, via socket)
RUN curl -fsSL --retry 5 --retry-all-errors https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz       | tar xz -C /usr/local/bin --strip-components=1 docker/docker  && mkdir -p /usr/local/lib/docker/cli-plugins  && curl -fsSL --retry 5 --retry-all-errors -o /usr/local/lib/docker/cli-plugins/docker-compose       https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Node.js (pruebas, lint y utilidades JSON de los scripts)
RUN curl -fsSL --retry 5 --retry-all-errors https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -  && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# Terraform
RUN curl -fsSL --retry 5 --retry-all-errors -o /tmp/terraform.zip       https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip  && unzip -o /tmp/terraform.zip terraform -d /usr/local/bin && rm /tmp/terraform.zip

# kubectl
RUN curl -fsSL --retry 5 --retry-all-errors -o /usr/local/bin/kubectl       https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl && chmod +x /usr/local/bin/kubectl

# AWS CLI v2
RUN curl -fsSL --retry 5 --retry-all-errors -o /tmp/awscli.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip  && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip

RUN terraform version && kubectl version --client && aws --version && node --version && docker --version && docker compose version

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
