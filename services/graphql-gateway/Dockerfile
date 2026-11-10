# =============================================================================
# Imagen de graphql-gateway
#
# Se construye desde la RAIZ del repositorio (contexto = monorepo), porque el
# servicio usa el paquete compartido packages/common:
#     docker build -f services/graphql-gateway/Dockerfile -t graphql-gateway .
#
# Dos etapas: "deps" instala dependencias (queda en cache mientras no cambien
# los package.json) y la etapa final solo copia lo necesario para ejecutar.
# =============================================================================
FROM node:22-alpine AS deps
WORKDIR /app
# Solo los manifiestos: asi "npm ci" se reutiliza desde cache si el codigo cambia.
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/station-reservation-service/package.json services/station-reservation-service/
COPY services/billing-wallet-service/package.json services/billing-wallet-service/
COPY services/energy-dispatch-service/package.json services/energy-dispatch-service/
COPY services/graphql-gateway/package.json services/graphql-gateway/
# Instala unicamente las dependencias de produccion de ESTE servicio.
RUN npm ci --omit=dev --workspace=graphql-gateway --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production     SERVICE_NAME=graphql-gateway     PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/common ./packages/common
COPY services/graphql-gateway ./services/graphql-gateway

# La version (SHA del commit) queda grabada en la imagen: aparece en /health,
# en cada linea de log y como dimension de las metricas del canary.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Sin privilegios de root dentro del contenedor.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3   CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/graphql-gateway/src/server.js"]
