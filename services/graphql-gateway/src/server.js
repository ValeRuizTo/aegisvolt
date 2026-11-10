// Punto de entrada del contenedor.
import { startServer } from '@aegisvolt/common';
import { buildApp } from './app.js';

const { app, apollo, config, logger, metrics } = await buildApp();

startServer(app, { config, logger, metrics, onShutdown: () => apollo.stop() });
