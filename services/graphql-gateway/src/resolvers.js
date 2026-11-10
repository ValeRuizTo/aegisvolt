// =============================================================================
// Resolvers GraphQL
//
// Cada resolver delega en el microservicio dueno del dato. El gateway no
// accede a las tablas de los servicios: solo a la suya (registro de SAGAs) y a
// la de feature flags.
// =============================================================================
import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { addToContext, currentContext, FLAGS } from '@aegisvolt/common';
import { ServiceError } from './clients.js';

/** Convierte un error de un microservicio en un error GraphQL con codigo. */
function toGraphQLError(err) {
  if (err instanceof GraphQLError) return err;
  if (err instanceof ServiceError) {
    return new GraphQLError(err.message, {
      extensions: { code: err.code, service: err.service, http: { status: 200 } },
    });
  }
  if (err?.code) {
    return new GraphQLError(err.message, { extensions: { code: err.code } });
  }
  return err;
}

const guarded = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    throw toGraphQLError(err);
  }
};

export function buildResolvers({ config, clients, flags, sagaStore, orchestrator, sagaDefinition, logger }) {
  const { station, billing, dispatch } = clients;

  async function serviceInfo(name, healthFn) {
    try {
      const health = await healthFn();
      return { name, status: health.status, version: health.version, track: health.track };
    } catch {
      return { name, status: 'unreachable', version: null, track: null };
    }
  }

  return {
    Query: {
      environment: async () => ({
        name: config.environment,
        version: config.version,
        track: config.track,
        services: await Promise.all([
          { name: config.serviceName, status: 'ok', version: config.version, track: config.track },
          serviceInfo('station-reservation-service', station.health),
          serviceInfo('billing-wallet-service', billing.health),
          serviceInfo('energy-dispatch-service', dispatch.health),
        ]),
      }),

      stations: guarded(() => station.listStations()),

      wallets: guarded(() => billing.listWallets()),
      wallet: guarded(async (_parent, { fleetId }) => {
        try {
          const { wallet, transactions } = await billing.getWallet(fleetId);
          return { ...wallet, transactions };
        } catch (err) {
          if (err.code === 'WALLET_NOT_FOUND') return null;
          throw err;
        }
      }),

      quote: guarded((_parent, { estimatedKwh, fastCharge }) => billing.quote({ estimatedKwh, fastCharge })),

      featureFlags: guarded(() => flags.list()),

      sagas: guarded((_parent, { limit }) => sagaStore.list({ limit: Math.min(Math.max(limit, 1), 200) })),
      saga: guarded((_parent, { sagaId }) => sagaStore.get(sagaId)),

      chargingSessions: guarded((_parent, { status }) => dispatch.listSessions(status)),
      chargingSession: guarded(async (_parent, { sagaId }) => {
        try {
          return await dispatch.getSession(sagaId);
        } catch (err) {
          if (err.code === 'SESSION_NOT_FOUND') return null;
          throw err;
        }
      }),
      telemetry: guarded((_parent, { sagaId, limit }) => dispatch.telemetry(sagaId, limit)),
    },

    Mutation: {
      // ----------------------------------------------------------------------
      // Disparador de la SAGA
      // ----------------------------------------------------------------------
      reserveAndCharge: guarded(async (_parent, { input }) => {
        if (!(input.estimatedKwh > 0 && input.estimatedKwh <= 500)) {
          throw new GraphQLError('estimatedKwh debe estar entre 0 y 500', { extensions: { code: 'VALIDATION_ERROR' } });
        }
        // Validacion temprana de la flag: evita iniciar una SAGA destinada a fallar.
        if (input.fastCharge && !(await flags.isEnabled(FLAGS.FAST_CHARGE_BOOST))) {
          throw new GraphQLError(
            `La ultra-carga prioritaria no esta habilitada en el ambiente ${config.environment} (flag ${FLAGS.FAST_CHARGE_BOOST})`,
            { extensions: { code: 'FAST_CHARGE_DISABLED' } },
          );
        }

        // Si el cliente envia clientRequestId, ese es el id de la SAGA: repetir
        // la mutacion (doble clic, reintento de red) no crea una segunda SAGA.
        const sagaId = input.clientRequestId ?? randomUUID();
        addToContext({ sagaId });

        return orchestrator.execute(sagaDefinition, {
          sagaId,
          correlationId: currentContext().correlationId,
          input: {
            fleetId: input.fleetId,
            stationId: input.stationId,
            connectorId: input.connectorId,
            estimatedKwh: input.estimatedKwh,
            fastCharge: input.fastCharge === true,
          },
        });
      }),

      stopCharging: guarded(async (_parent, { sagaId }) => {
        addToContext({ sagaId });
        // Dos llamadas idempotentes: si la segunda falla se puede repetir la mutacion.
        const { session } = await dispatch.stop(sagaId, { reason: 'USER_REQUEST' });
        if (!session) {
          throw new GraphQLError(`No existe una sesion de carga para ${sagaId}`, { extensions: { code: 'SESSION_NOT_FOUND' } });
        }
        await station.complete(sagaId);
        logger.info('Carga detenida por el usuario', { saga_id: sagaId });
        return session;
      }),

      compensateSaga: guarded(async (_parent, { sagaId }) => {
        addToContext({ sagaId });
        const saga = await orchestrator.recover(sagaDefinition, sagaId);
        if (!saga) throw new GraphQLError(`No existe la SAGA ${sagaId}`, { extensions: { code: 'SAGA_NOT_FOUND' } });
        return saga;
      }),

      setFeatureFlag: guarded(async (_parent, { name, enabled }) => {
        try {
          return await flags.set(name, enabled, 'graphql-api');
        } catch (err) {
          if (err.name === 'ConditionalCheckFailedException') {
            throw new GraphQLError(`La feature flag ${name} no existe en ${config.environment}`, {
              extensions: { code: 'FLAG_NOT_FOUND' },
            });
          }
          throw err;
        }
      }),

      topUpWallet: guarded(async (_parent, { fleetId, amount }) => {
        const wallet = await billing.topUp(fleetId, amount);
        return { ...wallet, transactions: null };
      }),
    },

    // ------------------------------------------------------------------------
    // Campos calculados
    // ------------------------------------------------------------------------
    Station: {
      availableConnectors: (stationItem) => stationItem.connectors.filter((c) => c.status === 'AVAILABLE').length,
    },

    Wallet: {
      // Solo se piden los movimientos si la consulta incluye el campo.
      transactions: guarded(async (wallet) => {
        if (Array.isArray(wallet.transactions)) return wallet.transactions;
        const { transactions } = await billing.getWallet(wallet.fleetId);
        return transactions;
      }),
    },

    Saga: {
      fleetId: (saga) => saga.input?.fleetId ?? null,
      stationId: (saga) => saga.input?.stationId ?? null,
      connectorId: (saga) => saga.input?.connectorId ?? null,
      estimatedKwh: (saga) => saga.input?.estimatedKwh ?? null,
      fastCharge: (saga) => saga.input?.fastCharge ?? null,
      amount: (saga) => saga.context?.amount ?? null,
    },

    ChargingSession: {
      latestTelemetry: guarded(async (session) => {
        if (session.status === 'FAILED') return null;
        const samples = await dispatch.telemetry(session.sagaId, 1);
        return samples.at(-1) ?? null;
      }),
    },
  };
}
