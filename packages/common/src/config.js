// =============================================================================
// Configuracion por variables de entorno (principio "12-factor").
//
// El MISMO contenedor corre en dev, test y prod. Lo unico que cambia entre
// ambientes son estas variables, inyectadas por Kubernetes (ConfigMap).
// =============================================================================

/**
 * Construye la configuracion de un servicio a partir del entorno.
 * Se puede sobreescribir cualquier valor (lo usan las pruebas).
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const environment = overrides.environment ?? env.APP_ENV ?? 'local';

  return {
    // Ambiente estatico: dev | test | prod (o "local"/"ci" fuera del cluster).
    environment,
    serviceName: overrides.serviceName ?? env.SERVICE_NAME ?? 'unknown-service',
    // Version desplegada (tag de la imagen = SHA corto del commit).
    version: overrides.version ?? env.APP_VERSION ?? 'dev',
    // "stable" o "canary": que Deployment de Kubernetes esta atendiendo.
    track: overrides.track ?? env.DEPLOY_TRACK ?? 'stable',
    port: Number(overrides.port ?? env.PORT ?? 3000),

    aws: {
      region: overrides.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1',
      // Con valor => emulador Floci. Vacio => endpoints reales de AWS.
      endpoint: overrides.endpoint ?? env.AWS_ENDPOINT_URL ?? undefined,
    },

    // Nombre real de cada tabla. Por defecto: aegisvolt-<dominio>-<ambiente>.
    tables: {
      reservations: env.TABLE_RESERVATIONS ?? `aegisvolt-reservations-${environment}`,
      billing: env.TABLE_BILLING ?? `aegisvolt-billing-${environment}`,
      dispatch: env.TABLE_DISPATCH ?? `aegisvolt-dispatch-${environment}`,
      sagas: env.TABLE_SAGAS ?? `aegisvolt-sagas-${environment}`,
      featureFlags: env.TABLE_FEATURE_FLAGS ?? `aegisvolt-feature-flags-${environment}`,
      ...overrides.tables,
    },

    observability: {
      // Grupo de logs: /aegisvolt/<ambiente>/<servicio>
      logGroupPrefix: env.LOG_GROUP_PREFIX ?? `/aegisvolt/${environment}`,
      cloudwatchLogs: (overrides.cloudwatchLogs ?? env.CLOUDWATCH_LOGS_ENABLED ?? 'false') === 'true',
      cloudwatchMetrics: (overrides.cloudwatchMetrics ?? env.CLOUDWATCH_METRICS_ENABLED ?? 'false') === 'true',
      logLevel: overrides.logLevel ?? env.LOG_LEVEL ?? 'info',
    },

    // Fraccion (0..1) de peticiones que fallan a proposito con HTTP 500.
    // Solo se usa para DEMOSTRAR el rollback automatico de un canary defectuoso.
    faultInjectionRate: Number(overrides.faultInjectionRate ?? env.FAULT_INJECTION_RATE ?? 0),

    // Cuanto tiempo se cachea el valor de una feature flag antes de releer DynamoDB.
    flagCacheTtlMs: Number(overrides.flagCacheTtlMs ?? env.FLAG_CACHE_TTL_MS ?? 3000),
  };
}
