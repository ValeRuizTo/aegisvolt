# =============================================================================
# Imagen del frontend (contexto de build = carpeta frontend/)
#   Etapa 1: compila la aplicacion React con Vite.
#   Etapa 2: nginx sin privilegios sirve los archivos estaticos en el puerto 8080.
# =============================================================================
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=${APP_VERSION}
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
# La plantilla se procesa al arrancar: sustituye ${GRAPHQL_UPSTREAM}.
ENV GRAPHQL_UPSTREAM=graphql-gateway.aegisvolt.svc.cluster.local:3000 \
    NGINX_ENVSUBST_FILTER=GRAPHQL_UPSTREAM
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
