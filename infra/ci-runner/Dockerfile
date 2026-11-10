# =============================================================================
# Runner auto-hospedado de GitHub Actions para AegisVolt
#
# Por que auto-hospedado: los ambientes viven en Floci, en esta maquina. Un
# runner de GitHub en la nube no puede alcanzar http://floci:4566 ni los
# clusters. Este contenedor se une a la red Docker "aegisvolt-net" y trae
# instaladas las herramientas que usan los pipelines.
# =============================================================================
FROM myoung34/github-runner:ubuntu-noble

ARG TERRAFORM_VERSION=1.16.2
ARG KUBECTL_VERSION=v1.31.5
ARG NODE_MAJOR=22

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl ca-certificates gettext-base gawk \
 && rm -rf /var/lib/apt/lists/*

# Node.js (pruebas, lint y utilidades JSON de los scripts)
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Terraform
RUN curl -fsSL -o /tmp/terraform.zip \
      https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip \
 && unzip -o /tmp/terraform.zip terraform -d /usr/local/bin && rm /tmp/terraform.zip

# kubectl
RUN curl -fsSL -o /usr/local/bin/kubectl https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl \
 && chmod +x /usr/local/bin/kubectl

# AWS CLI v2
RUN curl -fsSL -o /tmp/awscli.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip \
 && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscli.zip

RUN terraform version && kubectl version --client && aws --version && node --version
