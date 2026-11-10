// =============================================================================
// energy-dispatch-service :: API HTTP interna
//
//   POST /sessions                    SAGA paso 3: activar el cargador
//   POST /sessions/:sagaId/stop       Detener la carga (fin normal o compensacion)
//   GET  /sessions                    Sesiones de carga
//   GET  /sessions/:sagaId            Una sesion
//   GET  /sessions/:sagaId/telemetry  Telemetria registrada
//
// Aqui se evalua la flag SIMULATE_CHARGER_HARDWARE_FAULT: si esta activa en el
// ambiente, el cargador "reporta averia fisica" y el paso 3 falla, lo que
// obliga al orquestador a ejecutar las transacciones compensatorias.
// =============================================================================
import {
  createBaseApp,
  createServiceContext,
  installErrorHandlers,
  addToContext,
  notFound,
  requireFields,
  FLAGS,
  DomainError,
} from '@aegisvolt/common';
import { createDispatchRepository, SESSION_STATUS } from './repository.js';
import { buildSample, sampleIndexAt, SAMPLE_INTERVAL_SECONDS } from './telemetry.js';

export const SERVICE_NAME = 'energy-dispatch-service';

export function buildApp(overrides = {}) {
  const ctx = createServiceContext(SERVICE_NAME, overrides);
  const { config, logger, metrics, dynamo, flags } = ctx;
  const repository = overrides.repository ?? createDispatchRepository({ dynamo, tableName: config.tables.dispatch });

  const hardwareFault = (message) =>
    new DomainError('CHARGER_HARDWARE_FAULT', message, { status: 503, details: { retryable: false } });

  const app = createBaseApp({ config, logger, metrics });

  app.post('/sessions', async (req, res) => {
    requireFields(req.body, ['sagaId', 'stationId', 'connectorId', 'fleetId', 'powerKw', 'targetKwh']);
    const { sagaId, stationId, connectorId, fleetId } = req.body;
    addToContext({ sagaId });

    // Peticion repetida: se responde con el resultado de la primera vez.
    const existing = await repository.getSession(sagaId);
    if (existing) {
      if (existing.status === SESSION_STATUS.FAILED) throw hardwareFault(existing.failureReason);
      res.json({ session: existing, idempotentReplay: true });
      return;
    }

    const base = {
      sagaId,
      stationId,
      connectorId,
      fleetId,
      powerKw: Number(req.body.powerKw),
      targetKwh: Number(req.body.targetKwh),
    };

    // --- Inyeccion de fallo controlada por Feature Flag -----------------------
    if (await flags.isEnabled(FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT)) {
      const failureReason = `El cargador ${stationId}/${connectorId} reporto una averia fisica (flag ${FLAGS.SIMULATE_CHARGER_HARDWARE_FAULT} activa en ${config.environment})`;
      await repository.createSession({ ...base, status: SESSION_STATUS.FAILED, failureReason });
      logger.error('Fallo de hardware del cargador: no se pudo iniciar el flujo electrico', {
        saga_step: 'START_CHARGING',
        station_id: stationId,
        connector_id: connectorId,
        fault_injected: true,
      });
      throw hardwareFault(failureReason);
    }

    const startedAt = new Date().toISOString();
    const { session, created } = await repository.createSession({ ...base, status: SESSION_STATUS.ACTIVE, startedAt });
    if (created) await repository.putTelemetrySample(sagaId, buildSample(session, 0));

    logger.info('Cargador activado: flujo electrico iniciado', {
      saga_step: 'START_CHARGING',
      station_id: stationId,
      connector_id: connectorId,
      power_kw: session.powerKw,
      idempotent_replay: !created,
    });
    res.status(created ? 201 : 200).json({ session, idempotentReplay: !created });
  });

  app.post('/sessions/:sagaId/stop', async (req, res) => {
    const { sagaId } = req.params;
    addToContext({ sagaId });
    const reason = req.body?.reason ?? 'USER_REQUEST';

    const before = await repository.getSession(sagaId);
    if (before?.status === SESSION_STATUS.ACTIVE) {
      // Ultima muestra antes de cortar el flujo.
      await repository.putTelemetrySample(sagaId, buildSample(before, sampleIndexAt(before.startedAt)));
    }
    const result = await repository.stopSession(sagaId, reason);
    logger.info('Sesion de carga detenida', {
      saga_step: 'STOP_CHARGING',
      compensation: req.body?.compensation === true,
      stopped: result.stopped,
      reason,
    });
    res.json({ ...result, alreadyStopped: !result.stopped });
  });

  app.get('/sessions', async (req, res) => {
    res.json({ sessions: await repository.listSessions({ status: req.query.status }) });
  });

  app.get('/sessions/:sagaId', async (req, res) => {
    const session = await repository.getSession(req.params.sagaId);
    if (!session) throw notFound('SESSION_NOT_FOUND', `No existe sesion para la SAGA ${req.params.sagaId}`);
    res.json({ session });
  });

  app.get('/sessions/:sagaId/telemetry', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 30) || 30, 200);
    res.json({ telemetry: await repository.listTelemetry(req.params.sagaId, { limit }) });
  });

  installErrorHandlers(app, { logger });

  // ---------------------------------------------------------------------------
  // Registro periodico de telemetria de las sesiones activas
  // ---------------------------------------------------------------------------
  async function recordTelemetryTick() {
    const sessions = await repository.listSessions({ status: SESSION_STATUS.ACTIVE });
    let written = 0;
    for (const session of sessions) {
      const sample = buildSample(session, sampleIndexAt(session.startedAt));
      if (await repository.putTelemetrySample(session.sagaId, sample)) written += 1;
    }
    return written;
  }

  function startTelemetryLoop() {
    const timer = setInterval(() => {
      recordTelemetryTick().catch((err) => logger.warn('Fallo el registro de telemetria', { error: err.message }));
    }, SAMPLE_INTERVAL_SECONDS * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { app, repository, recordTelemetryTick, startTelemetryLoop, ...ctx };
}
