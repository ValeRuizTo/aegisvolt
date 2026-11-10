// =============================================================================
// Metricas de peticiones hacia Amazon CloudWatch Metrics
//
// Cada servicio cuenta cuantas peticiones atendio y cuantas terminaron en
// error 5xx, y publica esos contadores cada 10 s con PutMetricData:
//
//   Namespace : AegisVolt
//   Metricas  : RequestCount, ErrorCount
//   Dimensiones: Environment, Service, Version
//
// La dimension Version es la clave del CANARY: el pipeline consulta
// ErrorCount/RequestCount de la version nueva y decide promover o revertir.
// =============================================================================
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

export const METRICS_NAMESPACE = 'AegisVolt';

export function createMetrics(config, { logger, flushIntervalMs = 10000 } = {}) {
  const counters = { requests: 0, errors: 0 };
  // Totales desde que arranco el proceso (se exponen en /metrics para depurar).
  const totals = { requests: 0, errors: 0 };

  if (!config.observability.cloudwatchMetrics) {
    return {
      recordRequest(statusCode) {
        totals.requests += 1;
        if (statusCode >= 500) totals.errors += 1;
      },
      totals: () => ({ ...totals }),
      flush: async () => {},
    };
  }

  const client = new CloudWatchClient({ region: config.aws.region, endpoint: config.aws.endpoint });
  const dimensions = [
    { Name: 'Environment', Value: config.environment },
    { Name: 'Service', Value: config.serviceName },
    { Name: 'Version', Value: config.version },
  ];

  async function flush() {
    const { requests, errors } = counters;
    counters.requests = 0;
    counters.errors = 0;
    if (requests === 0) return;
    const timestamp = new Date();
    try {
      await client.send(
        new PutMetricDataCommand({
          Namespace: METRICS_NAMESPACE,
          MetricData: [
            { MetricName: 'RequestCount', Dimensions: dimensions, Timestamp: timestamp, Value: requests, Unit: 'Count' },
            { MetricName: 'ErrorCount', Dimensions: dimensions, Timestamp: timestamp, Value: errors, Unit: 'Count' },
          ],
        }),
      );
    } catch (err) {
      logger?.warn('No se pudieron publicar metricas en CloudWatch', { error: err.message });
    }
  }

  const timer = setInterval(flush, flushIntervalMs);
  timer.unref();

  return {
    recordRequest(statusCode) {
      counters.requests += 1;
      totals.requests += 1;
      if (statusCode >= 500) {
        counters.errors += 1;
        totals.errors += 1;
      }
    },
    totals: () => ({ ...totals }),
    flush,
  };
}
