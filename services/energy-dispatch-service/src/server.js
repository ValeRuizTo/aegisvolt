// Punto de entrada del contenedor.
import { startServer } from '@aegisvolt/common';
import { buildApp } from './app.js';

const { app, config, logger, metrics, startTelemetryLoop } = buildApp();

const stopTelemetry = startTelemetryLoop();
startServer(app, { config, logger, metrics, onShutdown: stopTelemetry });
