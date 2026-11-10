// =============================================================================
// PRUEBAS UNITARIAS - orquestador SAGA y compensaciones
//
// Sin red ni base de datos: los "servicios" son funciones falsas y el registro
// de SAGAs vive en memoria. Se prueba la LOGICA del orquestador: que compensa,
// en que orden, cuando reintenta y que deja registrado.
// =============================================================================
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSagaOrchestrator, SAGA_STATUS } from '../src/saga/orchestrator.js';
import { buildReserveAndChargeSaga } from '../src/saga/reserveAndCharge.js';
import { createInMemorySagaStore } from '../src/saga/store.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const INPUT = { fleetId: 'F1', stationId: 'S1', connectorId: 'C1', estimatedKwh: 20, fastCharge: false };

/** Error como los que produce clients.js. */
function serviceError(code, { ambiguous = false } = {}) {
  return Object.assign(new Error(code), { code, ambiguous });
}

/**
 * Servicios falsos que anotan cada llamada en "calls" (para verificar el orden).
 * "failures" indica que operacion debe fallar: { 'dispatch.start': error }.
 */
function fakeClients(failures = {}) {
  const calls = [];
  const op = (name, result = {}) => async (...args) => {
    calls.push(name);
    const failure = failures[name];
    if (typeof failure === 'function') {
      const outcome = failure(calls.filter((c) => c === name).length, ...args);
      if (outcome) throw outcome;
    } else if (failure) {
      throw failure;
    }
    return result;
  };
  return {
    calls,
    station: {
      reserve: op('station.reserve', { reservation: { powerKw: 150 } }),
      confirm: op('station.confirm'),
      release: op('station.release'),
    },
    billing: {
      charge: op('billing.charge', { transaction: { amount: 19000, quote: { surgeApplied: false } } }),
      refund: op('billing.refund'),
    },
    dispatch: {
      start: op('dispatch.start', { session: { status: 'ACTIVE' } }),
      stop: op('dispatch.stop'),
    },
  };
}

function setup(failures) {
  const clients = fakeClients(failures);
  const store = createInMemorySagaStore();
  const orchestrator = createSagaOrchestrator({ store, logger: silentLogger, environment: 'unit', sleep: async () => {} });
  const definition = buildReserveAndChargeSaga(clients);
  const run = (sagaId = 'saga-1') => orchestrator.execute(definition, { sagaId, input: INPUT, correlationId: 'corr-1' });
  return { clients, store, orchestrator, definition, run };
}

const step = (saga, name) => saga.steps.find((s) => s.name === name);

describe('camino feliz', () => {
  test('ejecuta los 4 pasos en orden y termina COMPLETED sin compensar', async () => {
    const { clients, run } = setup();
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPLETED);
    assert.deepEqual(clients.calls, ['station.reserve', 'billing.charge', 'dispatch.start', 'station.confirm']);
    assert.ok(saga.steps.every((s) => s.status === 'SUCCEEDED'));
    assert.equal(saga.failure, null);
    assert.ok(saga.finishedAt);
  });

  test('los datos de un paso llegan a los siguientes (context)', async () => {
    const { run } = setup();
    const saga = await run();
    assert.equal(saga.context.powerKw, 150);
    assert.equal(saga.context.amount, 19000);
  });

  test('persiste cada transicion: STARTED antes de cada paso, COMPLETED al final', async () => {
    const { store, run } = setup();
    await run();
    const statuses = store.history.map((s) => s.status);
    assert.equal(statuses.at(-1), 'COMPLETED');
    // 4 pasos x (RUNNING + SUCCEEDED) + cierre
    assert.equal(store.history.length, 9);
    assert.equal(store.history[0].steps[0].status, 'RUNNING');
  });
});

describe('fallo en el paso 3 (activacion fisica)', () => {
  test('compensa en ORDEN INVERSO: primero reembolso, luego liberacion', async () => {
    const { clients, run } = setup({ 'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT') });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATED);
    assert.deepEqual(clients.calls, [
      'station.reserve', 'billing.charge', 'dispatch.start', // pasos
      'billing.refund', 'station.release', // compensaciones
    ]);
  });

  test('registra que paso fallo y por que', async () => {
    const { run } = setup({ 'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT') });
    const saga = await run();

    assert.deepEqual(saga.failure, { step: 'START_CHARGING', code: 'CHARGER_HARDWARE_FAULT', message: 'CHARGER_HARDWARE_FAULT' });
    assert.equal(step(saga, 'START_CHARGING').status, 'FAILED');
    assert.equal(step(saga, 'CHARGE_WALLET').compensation.status, 'COMPENSATED');
    assert.equal(step(saga, 'RESERVE_CONNECTOR').compensation.status, 'COMPENSATED');
    assert.equal(step(saga, 'CONFIRM_RESERVATION').status, 'PENDING');
  });

  test('un rechazo definitivo NO compensa el propio paso fallido', async () => {
    const { clients, run } = setup({ 'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT') });
    const saga = await run();
    assert.ok(!clients.calls.includes('dispatch.stop'));
    assert.equal(step(saga, 'START_CHARGING').compensation.status, 'NOT_REQUIRED');
  });

  test('pasa por el estado COMPENSATING antes de COMPENSATED', async () => {
    const { store, run } = setup({ 'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT') });
    await run();
    const statuses = [...new Set(store.history.map((s) => s.status))];
    assert.deepEqual(statuses, ['STARTED', 'COMPENSATING', 'COMPENSATED']);
  });
});

describe('fallo en el paso 2 (fondos insuficientes)', () => {
  test('solo libera el conector; no reembolsa ni activa el cargador', async () => {
    const { clients, run } = setup({ 'billing.charge': serviceError('INSUFFICIENT_FUNDS') });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATED);
    assert.deepEqual(clients.calls, ['station.reserve', 'billing.charge', 'station.release']);
    assert.equal(saga.failure.code, 'INSUFFICIENT_FUNDS');
  });
});

describe('fallo en el paso 1 (conector ocupado)', () => {
  test('no hay nada que compensar', async () => {
    const { clients, run } = setup({ 'station.reserve': serviceError('CONNECTOR_NOT_AVAILABLE') });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATED);
    assert.deepEqual(clients.calls, ['station.reserve']);
  });
});

describe('fallos ambiguos (timeout / red)', () => {
  test('un paso se reintenta ante un fallo transitorio y la SAGA termina bien', async () => {
    const { clients, run } = setup({
      'billing.charge': (attempt) => (attempt === 1 ? serviceError('SERVICE_TIMEOUT', { ambiguous: true }) : null),
    });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPLETED);
    assert.equal(clients.calls.filter((c) => c === 'billing.charge').length, 2);
    assert.equal(step(saga, 'CHARGE_WALLET').attempts, 2);
  });

  test('si el timeout persiste, tambien se compensa el paso dudoso', async () => {
    // No se sabe si el cargador llego a activarse: hay que detenerlo por si acaso.
    const { clients, run } = setup({ 'dispatch.start': serviceError('SERVICE_TIMEOUT', { ambiguous: true }) });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATED);
    assert.deepEqual(clients.calls.slice(-3), ['dispatch.stop', 'billing.refund', 'station.release']);
    assert.equal(step(saga, 'START_CHARGING').compensation.status, 'COMPENSATED');
  });

  test('un rechazo de negocio NO se reintenta', async () => {
    const { clients, run } = setup({ 'billing.charge': serviceError('INSUFFICIENT_FUNDS') });
    await run();
    assert.equal(clients.calls.filter((c) => c === 'billing.charge').length, 1);
  });
});

describe('compensaciones que fallan', () => {
  test('una compensacion se reintenta hasta lograrlo', async () => {
    const { clients, run } = setup({
      'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT'),
      'billing.refund': (attempt) => (attempt < 3 ? serviceError('SERVICE_UNAVAILABLE', { ambiguous: true }) : null),
    });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATED);
    assert.equal(clients.calls.filter((c) => c === 'billing.refund').length, 3);
    assert.equal(step(saga, 'CHARGE_WALLET').compensation.attempts, 3);
  });

  test('si se agotan los reintentos queda COMPENSATION_FAILED, pero sigue con las demas', async () => {
    const { clients, run } = setup({
      'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT'),
      'billing.refund': serviceError('SERVICE_UNAVAILABLE', { ambiguous: true }),
    });
    const saga = await run();

    assert.equal(saga.status, SAGA_STATUS.COMPENSATION_FAILED);
    assert.equal(step(saga, 'CHARGE_WALLET').compensation.status, 'FAILED');
    // El conector se libera aunque el reembolso haya fallado.
    assert.ok(clients.calls.includes('station.release'));
    assert.equal(step(saga, 'RESERVE_CONNECTOR').compensation.status, 'COMPENSATED');
  });
});

describe('idempotencia y recuperacion', () => {
  test('ejecutar dos veces el mismo sagaId no repite los pasos', async () => {
    const { clients, run } = setup();
    const first = await run('saga-dup');
    const second = await run('saga-dup');

    assert.equal(second.sagaId, first.sagaId);
    assert.equal(second.status, SAGA_STATUS.COMPLETED);
    assert.equal(clients.calls.filter((c) => c === 'billing.charge').length, 1);
  });

  test('recover reintenta solo las compensaciones pendientes de una SAGA fallida', async () => {
    let refundAvailable = false;
    const { clients, orchestrator, definition, run } = setup({
      'dispatch.start': serviceError('CHARGER_HARDWARE_FAULT'),
      'billing.refund': () => (refundAvailable ? null : serviceError('SERVICE_UNAVAILABLE', { ambiguous: true })),
    });
    const failed = await run('saga-rec');
    assert.equal(failed.status, SAGA_STATUS.COMPENSATION_FAILED);

    refundAvailable = true; // billing vuelve a estar disponible
    clients.calls.length = 0;
    const recovered = await orchestrator.recover(definition, 'saga-rec');

    assert.equal(recovered.status, SAGA_STATUS.COMPENSATED);
    // La liberacion del conector ya estaba confirmada: no se repite.
    assert.deepEqual(clients.calls, ['billing.refund']);
  });

  test('recover rechaza una SAGA ya terminada', async () => {
    const { orchestrator, definition, run } = setup();
    await run('saga-ok');
    await assert.rejects(() => orchestrator.recover(definition, 'saga-ok'), { code: 'SAGA_ALREADY_FINISHED' });
  });

  test('recover rechaza una SAGA que todavia esta en ejecucion', async () => {
    const { orchestrator, definition, store } = setup();
    await store.create({ sagaId: 'saga-live', status: 'STARTED', steps: [], updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    await assert.rejects(() => orchestrator.recover(definition, 'saga-live'), { code: 'SAGA_IN_PROGRESS' });
  });

  test('recover de una SAGA inexistente devuelve null', async () => {
    const { orchestrator, definition } = setup();
    assert.equal(await orchestrator.recover(definition, 'nope'), null);
  });
});
