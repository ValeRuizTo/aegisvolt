// =============================================================================
// station-reservation-service :: API HTTP interna
//
//   GET  /stations                       Estado de electrolineras y conectores
//   POST /reservations                   SAGA paso 1: bloquear conector (RESERVED)
//   GET  /reservations/:sagaId           Consultar una reserva
//   POST /reservations/:sagaId/confirm   La carga inicio -> conector CHARGING
//   POST /reservations/:sagaId/release   COMPENSACION -> conector AVAILABLE
//   POST /reservations/:sagaId/complete  Fin normal de la carga -> AVAILABLE
//
// Solo el GraphQL gateway (orquestador) llama a esta API, dentro del cluster.
// =============================================================================
import {
  createBaseApp,
  createServiceContext,
  installErrorHandlers,
  addToContext,
  notFound,
  requireFields,
} from '@aegisvolt/common';
import { createReservationRepository, RESERVATION_STATUS } from './repository.js';

export const SERVICE_NAME = 'station-reservation-service';

export function buildApp(overrides = {}) {
  const ctx = createServiceContext(SERVICE_NAME, overrides);
  const { config, logger, metrics, dynamo } = ctx;
  const repository =
    overrides.repository ??
    createReservationRepository({
      dynamo,
      tableName: config.tables.reservations,
      lockTtlSeconds: Number(process.env.RESERVATION_LOCK_TTL_SECONDS ?? 300),
    });

  const app = createBaseApp({ config, logger, metrics });

  app.get('/stations', async (_req, res) => {
    res.json({ stations: await repository.listStations() });
  });

  app.post('/reservations', async (req, res) => {
    requireFields(req.body, ['sagaId', 'stationId', 'connectorId', 'fleetId']);
    const { sagaId, stationId, connectorId, fleetId, fastCharge } = req.body;
    addToContext({ sagaId });

    const result = await repository.reserve({ sagaId, stationId, connectorId, fleetId, fastCharge: fastCharge === true });
    logger.info('Conector reservado', {
      saga_step: 'RESERVE_CONNECTOR',
      station_id: stationId,
      connector_id: connectorId,
      idempotent_replay: result.idempotentReplay,
    });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  app.get('/reservations/:sagaId', async (req, res) => {
    const reservation = await repository.getReservation(req.params.sagaId);
    if (!reservation) throw notFound('RESERVATION_NOT_FOUND', `No existe reserva para la SAGA ${req.params.sagaId}`);
    res.json({ reservation });
  });

  app.post('/reservations/:sagaId/confirm', async (req, res) => {
    addToContext({ sagaId: req.params.sagaId });
    const result = await repository.confirm(req.params.sagaId);
    logger.info('Reserva confirmada: conector en CHARGING', {
      saga_step: 'CONFIRM_RESERVATION',
      idempotent_replay: result.idempotentReplay,
    });
    res.json(result);
  });

  app.post('/reservations/:sagaId/release', async (req, res) => {
    addToContext({ sagaId: req.params.sagaId });
    const result = await repository.finish(req.params.sagaId, RESERVATION_STATUS.RELEASED, req.body?.reason ?? null);
    logger.info('COMPENSACION: conector liberado', {
      saga_step: 'RELEASE_CONNECTOR',
      compensation: true,
      already_released: result.alreadyReleased,
      reason: req.body?.reason ?? null,
    });
    res.json(result);
  });

  app.post('/reservations/:sagaId/complete', async (req, res) => {
    addToContext({ sagaId: req.params.sagaId });
    const result = await repository.finish(req.params.sagaId, RESERVATION_STATUS.COMPLETED, 'CHARGE_FINISHED');
    logger.info('Carga finalizada: conector liberado', { already_released: result.alreadyReleased });
    res.json(result);
  });

  installErrorHandlers(app, { logger });
  return { app, repository, ...ctx };
}
