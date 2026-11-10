// Punto de entrada del contenedor.
import { startServer } from '@aegisvolt/common';
import { buildApp } from './app.js';

// Flotas de ejemplo. FLEET-CARIBE tiene saldo bajo a proposito: sirve para
// demostrar el fallo del paso 2 de la SAGA (fondos insuficientes).
export const SEED_WALLETS = [
  { fleetId: 'FLEET-ANDES', fleetName: 'Andes Express Logistica', balance: 500000 },
  { fleetId: 'FLEET-PACIFICO', fleetName: 'Pacifico Ultima Milla', balance: 250000 },
  { fleetId: 'FLEET-CARIBE', fleetName: 'Caribe Cargo (saldo bajo)', balance: 5000 },
];

const { app, repository, config, logger, metrics } = buildApp();

try {
  const created = await repository.seed(SEED_WALLETS);
  logger.info('Datos iniciales verificados', { items_created: created, table: config.tables.billing });
} catch (err) {
  logger.error('No se pudieron crear los datos iniciales', { error: err.message });
}

startServer(app, { config, logger, metrics });
