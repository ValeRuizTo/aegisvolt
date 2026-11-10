import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { createDynamoClient } from './dynamo.js';
import { createFeatureFlags } from './featureFlags.js';

export { loadConfig } from './config.js';
export {
  runWithContext,
  currentContext,
  addToContext,
  newCorrelationId,
  CORRELATION_HEADER,
} from './context.js';
export { createLogger } from './logger.js';
export { createMetrics, METRICS_NAMESPACE } from './metrics.js';
export { createDynamoClient, isConditionalCheckFailed, transactionCancellationCodes } from './dynamo.js';
export { createFeatureFlags, FLAGS } from './featureFlags.js';
export { DomainError, notFound, conflict, badRequest, requireFields } from './errors.js';
export { createBaseApp, installErrorHandlers, startServer } from './http.js';

/**
 * Crea las piezas transversales de un servicio en una sola llamada.
 * Devuelve { config, logger, metrics, dynamo, flags }.
 */

export function createServiceContext(serviceName, overrides = {}) {
  const config = loadConfig({ serviceName, ...overrides });
  const logger = overrides.logger ?? createLogger(config);
  const metrics = createMetrics(config, { logger });
  const dynamo = overrides.dynamo ?? createDynamoClient(config);
  const flags =
    overrides.flags ??
    createFeatureFlags({
      dynamo,
      tableName: config.tables.featureFlags,
      ttlMs: config.flagCacheTtlMs,
      logger,
    });
  return { config, logger, metrics, dynamo, flags };
}
