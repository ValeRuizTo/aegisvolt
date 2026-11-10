// =============================================================================
// Logger estructurado (JSON) con envio a Amazon CloudWatch Logs
//
// Cada linea de log es un objeto JSON con, como minimo:
//   timestamp, level, message, service, environment, version, correlation_id
//
// Destinos:
//   1. stdout  -> "kubectl logs" (siempre).
//   2. CloudWatch Logs -> grupo /aegisvolt/<ambiente>/<servicio>, un stream por
//      pod. Los eventos se acumulan en memoria y se envian en lote cada 2 s
//      con PutLogEvents (una llamada por lote, no una por linea).
//
// Si CloudWatch no responde, el servicio NO falla: el log ya salio por stdout.
// =============================================================================
import os from 'node:os';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { currentContext } from './context.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class CloudWatchShipper {
  constructor({ config, flushIntervalMs = 2000 }) {
    this.client = new CloudWatchLogsClient({
      region: config.aws.region,
      endpoint: config.aws.endpoint,
    });
    this.logGroupName = `${config.observability.logGroupPrefix}/${config.serviceName}`;
    // Un stream por pod: permite saber que replica (y que version) escribio.
    this.logStreamName = `${config.track}-${config.version}-${os.hostname()}`;
    this.buffer = [];
    this.ready = null;
    this.timer = setInterval(() => this.flush(), flushIntervalMs);
    this.timer.unref(); // no impide que el proceso termine
  }

  async ensureStream() {
    const ignoreExists = (err) => {
      if (err.name !== 'ResourceAlreadyExistsException') throw err;
    };
    // El grupo lo crea Terraform; se intenta crear solo por si se ejecuta
    // fuera del cluster (docker compose, pruebas).
    await this.client
      .send(new CreateLogGroupCommand({ logGroupName: this.logGroupName }))
      .catch(ignoreExists);
    await this.client
      .send(new CreateLogStreamCommand({ logGroupName: this.logGroupName, logStreamName: this.logStreamName }))
      .catch(ignoreExists);
  }

  push(entry) {
    this.buffer.push({ timestamp: Date.now(), message: JSON.stringify(entry) });
    if (this.buffer.length >= 200) this.flush();
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    try {
      this.ready ??= this.ensureStream();
      await this.ready;
      await this.client.send(
        new PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          logEvents: events,
        }),
      );
    } catch (err) {
      this.ready = null; // se reintenta crear el stream en el proximo flush
      process.stderr.write(`[logger] no se pudo enviar a CloudWatch: ${err.name}: ${err.message}\n`);
    }
  }
}

/**
 * Crea el logger de un servicio.
 * Uso: log.info('mensaje', { campo: valor })
 */
export function createLogger(config, { sink } = {}) {
  const minLevel = LEVELS[config.observability.logLevel] ?? LEVELS.info;
  const shipper = config.observability.cloudwatchLogs ? new CloudWatchShipper({ config }) : null;
  const write = sink ?? ((line) => process.stdout.write(`${line}\n`));

  function emit(level, message, fields = {}) {
    if (LEVELS[level] < minLevel) return;
    const ctx = currentContext();
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      service: config.serviceName,
      environment: config.environment,
      version: config.version,
      track: config.track,
      // Identificador que une todos los logs de una misma SAGA / peticion,
      // sin importar que microservicio los escribio.
      correlation_id: ctx.correlationId ?? null,
      ...(ctx.sagaId ? { saga_id: ctx.sagaId } : {}),
      ...fields,
    };
    write(JSON.stringify(entry));
    shipper?.push(entry);
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    /** Envia lo pendiente a CloudWatch (se llama al apagar el servicio). */
    flush: () => shipper?.flush() ?? Promise.resolve(),
  };
}
