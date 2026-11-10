// =============================================================================
// Base HTTP comun a los microservicios (Express)
//
//  * correlation_id: se lee de la cabecera x-correlation-id (o se genera) y se
//    guarda en el contexto de la peticion; todos los logs lo incluyen.
//  * /health: usado por Kubernetes (readiness/liveness) y por el canary.
//  * Log y metrica de cada peticion.
//  * Manejo uniforme de errores -> { error: { code, message } }.
//  * Inyeccion de fallos opcional (FAULT_INJECTION_RATE) para demostrar el
//    rollback de un canary defectuoso.
// =============================================================================
import express from 'express';
import { CORRELATION_HEADER, newCorrelationId, runWithContext } from './context.js';
import { DomainError } from './errors.js';

export function createBaseApp({ config, logger, metrics }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // --- Salud: no pasa por inyeccion de fallos ni genera logs/metricas --------
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: config.serviceName,
      environment: config.environment,
      version: config.version,
      track: config.track,
    });
  });

  app.get('/metrics', (_req, res) => {
    res.json({ service: config.serviceName, version: config.version, ...metrics.totals() });
  });

  // --- Contexto de correlacion + log + metrica por peticion -------------------
  app.use((req, res, next) => {
    const correlationId = req.get(CORRELATION_HEADER) || newCorrelationId();
    res.set(CORRELATION_HEADER, correlationId);
    // Permite ver desde fuera que version/track atendio (util en el canary).
    res.set('x-served-by-version', config.version);
    res.set('x-served-by-track', config.track);

    const startedAt = process.hrtime.bigint();
    runWithContext({ correlationId }, () => {
      res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        metrics.recordRequest(res.statusCode);
        const level = res.statusCode >= 500 ? 'error' : 'info';
        logger[level]('http_request', {
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          duration_ms: Math.round(durationMs * 10) / 10,
        });
      });
      next();
    });
  });

  // --- Inyeccion de fallos (solo demo de canary) -------------------------------
  if (config.faultInjectionRate > 0) {
    logger.warn('Inyeccion de fallos ACTIVA', { fault_injection_rate: config.faultInjectionRate });
    app.use((_req, res, next) => {
      if (Math.random() < config.faultInjectionRate) {
        res.status(500).json({ error: { code: 'INJECTED_FAULT', message: 'Fallo inyectado (demo de canary)' } });
        return;
      }
      next();
    });
  }

  return app;
}

/** Debe registrarse DESPUES de las rutas del servicio. */
export function installErrorHandlers(app, { logger }) {
  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` } });
  });

  // Express reconoce un manejador de errores por sus 4 parametros.
  app.use((err, _req, res, _next) => {
    if (err instanceof DomainError) {
      logger.warn('Error de negocio', { code: err.code, error: err.message, status: err.status });
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Cuerpo JSON invalido' } });
      return;
    }
    logger.error('Error no controlado', { error: err.message, stack: err.stack });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Error interno del servicio' } });
  });
}

/**
 * Arranca el servidor HTTP y maneja el apagado ordenado (SIGTERM de Kubernetes):
 * deja de aceptar conexiones, envia logs/metricas pendientes y termina.
 */
export function startServer(app, { config, logger, metrics, onShutdown }) {
  const server = app.listen(config.port, () => {
    logger.info('Servicio iniciado', { port: config.port });
  });

  const shutdown = async (signal) => {
    logger.info('Apagando servicio', { signal });
    server.close();
    try {
      await onShutdown?.();
      await metrics.flush();
      await logger.flush();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}
