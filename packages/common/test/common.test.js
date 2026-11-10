// PRUEBAS UNITARIAS - piezas transversales (logs, flags, configuracion)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureFlags, createLogger, loadConfig, runWithContext, addToContext } from '../src/index.js';

describe('logger estructurado', () => {
  function capture(overrides = {}) {
    const lines = [];
    const config = loadConfig({ serviceName: 'billing-wallet-service', environment: 'test', version: 'abc123', ...overrides });
    const logger = createLogger(config, { sink: (line) => lines.push(JSON.parse(line)) });
    return { lines, logger };
  }

  test('cada linea es JSON con servicio, ambiente, version y nivel', () => {
    const { lines, logger } = capture();
    logger.info('hola', { amount: 5 });
    assert.equal(lines.length, 1);
    const [entry] = lines;
    assert.equal(entry.level, 'INFO');
    assert.equal(entry.message, 'hola');
    assert.equal(entry.service, 'billing-wallet-service');
    assert.equal(entry.environment, 'test');
    assert.equal(entry.version, 'abc123');
    assert.equal(entry.amount, 5);
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  });

  test('incluye el correlation_id y el saga_id del contexto de la peticion', () => {
    const { lines, logger } = capture();
    runWithContext({ correlationId: 'corr-42' }, () => {
      logger.info('antes');
      addToContext({ sagaId: 'saga-7' });
      logger.warn('despues');
    });
    assert.equal(lines[0].correlation_id, 'corr-42');
    assert.equal(lines[0].saga_id, undefined);
    assert.equal(lines[1].correlation_id, 'corr-42');
    assert.equal(lines[1].saga_id, 'saga-7');
  });

  test('fuera de una peticion el correlation_id es null', () => {
    const { lines, logger } = capture();
    logger.info('arranque');
    assert.equal(lines[0].correlation_id, null);
  });

  test('contextos de peticiones concurrentes no se mezclan', async () => {
    const { lines, logger } = capture();
    const request = (id, delay) =>
      runWithContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        logger.info('fin');
      });
    await Promise.all([request('A', 15), request('B', 1)]);
    assert.deepEqual(lines.map((l) => l.correlation_id), ['B', 'A']);
  });

  test('respeta el nivel minimo de log', () => {
    const { lines, logger } = capture({ logLevel: 'warn' });
    logger.info('se descarta');
    logger.error('se conserva');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'ERROR');
  });
});

describe('configuracion por ambiente', () => {
  test('los nombres de tabla y el grupo de logs se derivan del ambiente', () => {
    const config = loadConfig({ serviceName: 'x', environment: 'prod' });
    assert.equal(config.tables.billing, 'aegisvolt-billing-prod');
    assert.equal(config.tables.featureFlags, 'aegisvolt-feature-flags-prod');
    assert.equal(config.observability.logGroupPrefix, '/aegisvolt/prod');
  });
});

describe('feature flags', () => {
  /** DynamoDB falso: cuenta las lecturas y devuelve el valor configurado. */
  function fakeDynamo(state) {
    return {
      reads: 0,
      async send(command) {
        const name = command.constructor.name;
        if (name === 'GetCommand') {
          this.reads += 1;
          if (state.fail) throw new Error('DynamoDB no disponible');
          const flag = command.input.Key.flag_name;
          return flag in state.flags ? { Item: { flag_name: flag, enabled: state.flags[flag] } } : {};
        }
        if (name === 'UpdateCommand') {
          const flag = command.input.Key.flag_name;
          state.flags[flag] = command.input.ExpressionAttributeValues[':enabled'];
          return { Attributes: { flag_name: flag, enabled: state.flags[flag] } };
        }
        throw new Error(`comando inesperado: ${name}`);
      },
    };
  }

  test('lee el valor de la tabla del ambiente', async () => {
    const dynamo = fakeDynamo({ flags: { A: true, B: false } });
    const flags = createFeatureFlags({ dynamo, tableName: 't' });
    assert.equal(await flags.isEnabled('A'), true);
    assert.equal(await flags.isEnabled('B'), false);
  });

  test('una flag inexistente se considera apagada', async () => {
    const flags = createFeatureFlags({ dynamo: fakeDynamo({ flags: {} }), tableName: 't' });
    assert.equal(await flags.isEnabled('NO_EXISTE'), false);
  });

  test('cachea el valor durante el TTL y lo relee al vencer', async () => {
    let clock = 1000;
    const state = { flags: { A: false } };
    const dynamo = fakeDynamo(state);
    const flags = createFeatureFlags({ dynamo, tableName: 't', ttlMs: 3000, now: () => clock });

    assert.equal(await flags.isEnabled('A'), false);
    state.flags.A = true; // alguien cambia la flag en DynamoDB
    clock += 2000;
    assert.equal(await flags.isEnabled('A'), false, 'dentro del TTL sigue el valor cacheado');
    assert.equal(dynamo.reads, 1);

    clock += 1500; // vence el TTL
    assert.equal(await flags.isEnabled('A'), true, 'sin reiniciar el servicio ve el nuevo valor');
    assert.equal(dynamo.reads, 2);
  });

  test('set invalida el cache de inmediato', async () => {
    const dynamo = fakeDynamo({ flags: { A: false } });
    const flags = createFeatureFlags({ dynamo, tableName: 't', ttlMs: 60000 });
    assert.equal(await flags.isEnabled('A'), false);
    await flags.set('A', true);
    assert.equal(await flags.isEnabled('A'), true);
  });

  test('fallo seguro: si DynamoDB no responde la flag se asume apagada', async () => {
    const flags = createFeatureFlags({ dynamo: fakeDynamo({ flags: { A: true }, fail: true }), tableName: 't' });
    assert.equal(await flags.isEnabled('A'), false);
  });
});
