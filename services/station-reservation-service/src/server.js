// Punto de entrada del contenedor.
import { startServer } from '@aegisvolt/common';
import { buildApp } from './app.js';
import { SEED_STATIONS } from './seed.js';

const { app, repository, config, logger, metrics } = buildApp();

try {
  const created = await repository.seed(SEED_STATIONS);
  logger.info('Datos iniciales verificados', { items_created: created, table: config.tables.reservations });
} catch (err) {
  logger.error('No se pudieron crear los datos iniciales', { error: err.message });
}

startServer(app, { config, logger, metrics });
