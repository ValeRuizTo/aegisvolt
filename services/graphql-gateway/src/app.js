// =============================================================================
// graphql-gateway :: capa de agregacion GraphQL + orquestador SAGA
//
//   POST /graphql   Endpoint GraphQL unico (Queries y Mutations)
//   GET  /health    Salud (Kubernetes / canary)
//
// Es el unico servicio expuesto fuera del cluster (a traves del API Gateway).
// =============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { createBaseApp, createServiceContext, installErrorHandlers } from '@aegisvolt/common';
import { createServiceClients } from './clients.js';
import { buildResolvers } from './resolvers.js';
import { createSagaOrchestrator } from './saga/orchestrator.js';
import { buildReserveAndChargeSaga } from './saga/reserveAndCharge.js';
import { createDynamoSagaStore } from './saga/store.js';

export const SERVICE_NAME = 'graphql-gateway';

export const typeDefs = readFileSync(fileURLToPath(new URL('./schema.graphql', import.meta.url)), 'utf8');

export async function buildApp(overrides = {}) {
  const ctx = createServiceContext(SERVICE_NAME, overrides);
  const { config, logger, metrics, dynamo, flags } = ctx;

  const clients =
    overrides.clients ??
    createServiceClients({
      urls: overrides.serviceUrls ?? {
        station: process.env.STATION_SERVICE_URL ?? 'http://station-reservation-service:3000',
        billing: process.env.BILLING_SERVICE_URL ?? 'http://billing-wallet-service:3000',
        dispatch: process.env.DISPATCH_SERVICE_URL ?? 'http://energy-dispatch-service:3000',
      },
      timeoutMs: Number(process.env.SERVICE_TIMEOUT_MS ?? 5000),
    });

  const sagaStore = overrides.sagaStore ?? createDynamoSagaStore({ dynamo, tableName: config.tables.sagas });
  const orchestrator = createSagaOrchestrator({ store: sagaStore, logger, environment: config.environment });
  const sagaDefinition = buildReserveAndChargeSaga(clients);

  const apollo = new ApolloServer({
    typeDefs,
    resolvers: buildResolvers({ config, clients, flags, sagaStore, orchestrator, sagaDefinition, logger }),
    // La introspeccion queda activa en todos los ambientes para poder explorar
    // el esquema durante la sustentacion.
    introspection: true,
    formatError: (formatted) => {
      if (formatted.extensions?.code === 'INTERNAL_SERVER_ERROR') {
        logger.error('Error interno en GraphQL', { error: formatted.message, path: formatted.path });
      }
      return formatted;
    },
  });
  await apollo.start();

  const app = createBaseApp({ config, logger, metrics });

  // CORS simple: permite abrir el frontend en modo desarrollo (otro origen).
  app.use('/graphql', (req, res, next) => {
    res.set('access-control-allow-origin', '*');
    res.set('access-control-allow-headers', 'content-type, x-correlation-id');
    res.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use('/graphql', expressMiddleware(apollo));

  installErrorHandlers(app, { logger });
  return { app, apollo, clients, sagaStore, orchestrator, sagaDefinition, ...ctx };
}
