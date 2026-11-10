// =============================================================================
// PRUEBAS DE INTEGRACION - endpoint GraphQL + SAGA completa
//
// Recorren el flujo "Reservar y Activar Carga" de punta a punta (gateway ->
// 3 microservicios -> DynamoDB) y comprueban en las TABLAS el resultado de las
// transacciones compensatorias.
// =============================================================================
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startPlatform } from './helpers/harness.js';

let p;
before(async () => {
  p = await startPlatform();
});
after(async () => {
  await p?.stop();
});

const RESERVE = /* GraphQL */ `
  mutation Reserve($input: ReserveAndChargeInput!) {
    reserveAndCharge(input: $input) {
      sagaId status correlationId environment amount
      failure { step code message }
      steps { name status service attempts compensation { name status attempts } }
    }
  }
`;

const reserve = (input, headers) => p.graphql(RESERVE, { input }, headers);
const connector = (stationId, connectorId) =>
  p.getItem(p.tables.reservations, { pk: `STATION#${stationId}`, sk: `CONNECTOR#${connectorId}` });
const balance = async (fleetId) => (await p.getItem(p.tables.billing, { pk: `WALLET#${fleetId}`, sk: 'BALANCE' })).balance;
const step = (saga, name) => saga.steps.find((s) => s.name === name);

describe('esquema y consultas', () => {
  test('el esquema expone las Queries y Mutations requeridas', async () => {
    const { data } = await p.graphql(`{ __schema { queryType { fields { name } } mutationType { fields { name } } } }`);
    const queries = data.__schema.queryType.fields.map((f) => f.name);
    const mutations = data.__schema.mutationType.fields.map((f) => f.name);
    for (const q of ['stations', 'telemetry', 'featureFlags', 'sagas', 'wallets', 'environment']) assert.ok(queries.includes(q), q);
    for (const m of ['reserveAndCharge', 'stopCharging', 'setFeatureFlag', 'compensateSaga']) assert.ok(mutations.includes(m), m);
  });

  test('stations agrega datos del servicio de reservas', async () => {
    const { data, errors } = await p.graphql(`{ stations { stationId name availableConnectors connectors { connectorId status powerKw ultraFast } } }`);
    assert.equal(errors, undefined);
    assert.equal(data.stations.length, 3);
    assert.equal(data.stations.find((s) => s.stationId === 'ST-BOG-01').availableConnectors, 4);
  });

  test('environment informa el ambiente y la salud de los 3 microservicios', async () => {
    const { data } = await p.graphql(`{ environment { name services { name status } } }`);
    assert.equal(data.environment.name, p.environment);
    assert.equal(data.environment.services.length, 4);
    assert.ok(data.environment.services.every((s) => s.status === 'ok'));
  });

  test('featureFlags lista las tres flags del ambiente', async () => {
    const { data } = await p.graphql(`{ featureFlags { name enabled } }`);
    assert.deepEqual(data.featureFlags.map((f) => f.name), [
      'ENABLE_DYNAMIC_SURGE_PRICING', 'ENABLE_FAST_CHARGE_BOOST', 'SIMULATE_CHARGER_HARDWARE_FAULT',
    ]);
  });
});

describe('SAGA - camino feliz', () => {
  let saga;

  test('la mutacion completa los 4 pasos y deja la SAGA en COMPLETED', async () => {
    const { data, errors } = await reserve(
      { fleetId: 'FLEET-RICH', stationId: 'ST-BOG-01', connectorId: 'C1', estimatedKwh: 40 },
      { 'x-correlation-id': 'corr-happy-path' },
    );
    assert.equal(errors, undefined);
    saga = data.reserveAndCharge;
    assert.equal(saga.status, 'COMPLETED');
    assert.equal(saga.correlationId, 'corr-happy-path');
    assert.deepEqual(saga.steps.map((s) => `${s.name}:${s.status}`), [
      'RESERVE_CONNECTOR:SUCCEEDED', 'CHARGE_WALLET:SUCCEEDED', 'START_CHARGING:SUCCEEDED', 'CONFIRM_RESERVATION:SUCCEEDED',
    ]);
    assert.equal(saga.failure, null);
    assert.equal(saga.amount, 38000);
  });

  test('las tres tablas reflejan el resultado', async () => {
    assert.equal((await connector('ST-BOG-01', 'C1')).status, 'CHARGING');
    assert.equal(await balance('FLEET-RICH'), 500000 - 38000);
    const session = await p.getItem(p.tables.dispatch, { pk: `SESSION#${saga.sagaId}`, sk: 'META' });
    assert.equal(session.status, 'ACTIVE');
  });

  test('la telemetria de la sesion se consulta por GraphQL', async () => {
    const { data } = await p.graphql(
      `query($id: ID!) { chargingSession(sagaId: $id) { status latestTelemetry { kwhDelivered powerKw } } telemetry(sagaId: $id) { sampleIndex } }`,
      { id: saga.sagaId },
    );
    assert.equal(data.chargingSession.status, 'ACTIVE');
    assert.ok(data.telemetry.length >= 1);
  });

  test('stopCharging detiene la sesion y libera el conector', async () => {
    const { data, errors } = await p.graphql(`mutation($id: ID!) { stopCharging(sagaId: $id) { status } }`, { id: saga.sagaId });
    assert.equal(errors, undefined);
    assert.equal(data.stopCharging.status, 'STOPPED');
    assert.equal((await connector('ST-BOG-01', 'C1')).status, 'AVAILABLE');
  });
});

describe('SAGA - fallo en el paso 3 (averia del cargador) => rollback distribuido', () => {
  let saga;
  let balanceBefore;

  test('con la flag de fallo activa la SAGA termina COMPENSATED', async () => {
    balanceBefore = await balance('FLEET-RICH');
    await p.setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);

    const { data, errors } = await reserve(
      { fleetId: 'FLEET-RICH', stationId: 'ST-BOG-01', connectorId: 'C2', estimatedKwh: 30 },
      { 'x-correlation-id': 'corr-hardware-fault' },
    );
    await p.setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);

    assert.equal(errors, undefined);
    saga = data.reserveAndCharge;
    assert.equal(saga.status, 'COMPENSATED');
    assert.deepEqual(saga.failure.step, 'START_CHARGING');
    assert.deepEqual(saga.failure.code, 'CHARGER_HARDWARE_FAULT');
  });

  test('los pasos 1 y 2 quedaron compensados; el paso 4 nunca se ejecuto', () => {
    assert.equal(step(saga, 'RESERVE_CONNECTOR').compensation.status, 'COMPENSATED');
    assert.equal(step(saga, 'CHARGE_WALLET').compensation.status, 'COMPENSATED');
    assert.equal(step(saga, 'START_CHARGING').status, 'FAILED');
    // Fallo definitivo del paso 3 (no ambiguo): no hay nada que detener.
    assert.equal(step(saga, 'START_CHARGING').compensation.status, 'NOT_REQUIRED');
    assert.equal(step(saga, 'CONFIRM_RESERVATION').status, 'PENDING');
  });

  test('billing: el saldo se restauro y existen el cobro y su reversion', async () => {
    assert.equal(await balance('FLEET-RICH'), balanceBefore);
    const charge = await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-RICH', sk: `TX#${saga.sagaId}#CHARGE` });
    const refund = await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-RICH', sk: `TX#${saga.sagaId}#REFUND` });
    assert.equal(charge.status, 'REFUNDED');
    assert.equal(refund.amount, charge.amount);
    assert.equal(refund.reason, 'CHARGER_HARDWARE_FAULT');
    assert.equal(refund.correlationId, 'corr-hardware-fault');
  });

  test('reservations: el conector volvio a AVAILABLE y la reserva quedo RELEASED', async () => {
    assert.equal((await connector('ST-BOG-01', 'C2')).status, 'AVAILABLE');
    const reservation = await p.getItem(p.tables.reservations, { pk: `RESERVATION#${saga.sagaId}`, sk: 'META' });
    assert.equal(reservation.status, 'RELEASED');
    assert.equal(reservation.statusReason, 'CHARGER_HARDWARE_FAULT');
  });

  test('el registro de la SAGA persiste en la tabla sagas con su correlation_id', async () => {
    const item = await p.getItem(p.tables.sagas, { pk: `SAGA#${saga.sagaId}`, sk: 'META' });
    assert.equal(item.status, 'COMPENSATED');
    assert.equal(item.correlationId, 'corr-hardware-fault');
    assert.ok(item.finishedAt);
  });

  test('el orden de compensacion fue inverso: primero reembolso, despues liberacion', async () => {
    const item = await p.getItem(p.tables.sagas, { pk: `SAGA#${saga.sagaId}`, sk: 'META' });
    const refundAt = item.steps.find((s) => s.name === 'CHARGE_WALLET').compensation.finishedAt;
    const releaseAt = item.steps.find((s) => s.name === 'RESERVE_CONNECTOR').compensation.finishedAt;
    assert.ok(refundAt <= releaseAt, `reembolso ${refundAt} debe ocurrir antes que liberacion ${releaseAt}`);
  });
});

describe('SAGA - fallo en el paso 2 (fondos insuficientes)', () => {
  test('solo se compensa la reserva; no hay cobro ni activacion', async () => {
    const { data } = await reserve({ fleetId: 'FLEET-POOR', stationId: 'ST-MED-01', connectorId: 'C2', estimatedKwh: 25 });
    const saga = data.reserveAndCharge;

    assert.equal(saga.status, 'COMPENSATED');
    assert.equal(saga.failure.step, 'CHARGE_WALLET');
    assert.equal(saga.failure.code, 'INSUFFICIENT_FUNDS');
    assert.equal(step(saga, 'RESERVE_CONNECTOR').compensation.status, 'COMPENSATED');
    assert.equal(step(saga, 'CHARGE_WALLET').compensation.status, 'NOT_REQUIRED');
    assert.equal(step(saga, 'START_CHARGING').status, 'PENDING');

    assert.equal((await connector('ST-MED-01', 'C2')).status, 'AVAILABLE');
    assert.equal(await balance('FLEET-POOR'), 1000);
    assert.equal(await p.getItem(p.tables.dispatch, { pk: `SESSION#${saga.sagaId}`, sk: 'META' }), null);
  });
});

describe('SAGA - idempotencia y recuperacion', () => {
  test('repetir la mutacion con el mismo clientRequestId no crea otra SAGA ni cobra dos veces', async () => {
    const before = await balance('FLEET-RICH');
    const input = { fleetId: 'FLEET-RICH', stationId: 'ST-CAL-01', connectorId: 'C1', estimatedKwh: 10, clientRequestId: 'req-dup-1' };
    const first = (await reserve(input)).data.reserveAndCharge;
    const second = (await reserve(input)).data.reserveAndCharge;

    assert.equal(first.status, 'COMPLETED');
    assert.equal(second.sagaId, first.sagaId);
    assert.equal(await balance('FLEET-RICH'), before - 9500, 'se cobro una sola vez');
    await p.graphql(`mutation { stopCharging(sagaId: "req-dup-1") { status } }`);
  });

  test('compensateSaga sobre una SAGA terminada es rechazada', async () => {
    const { errors } = await p.graphql(`mutation { compensateSaga(sagaId: "req-dup-1") { status } }`);
    assert.equal(errors[0].extensions.code, 'SAGA_ALREADY_FINISHED');
  });

  test('una SAGA huerfana (orquestador caido tras cobrar) se recupera con compensateSaga', async () => {
    // Se reproduce a mano el estado que dejaria un gateway que muere despues
    // del paso 2: conector reservado, saldo descontado, SAGA en STARTED.
    const sagaId = 'orphan-1';
    const before = await balance('FLEET-RICH');
    await p.http('POST', `${p.urls.station}/reservations`, { sagaId, stationId: 'ST-CAL-01', connectorId: 'C2', fleetId: 'FLEET-RICH' });
    await p.http('POST', `${p.urls.billing}/charges`, { sagaId, fleetId: 'FLEET-RICH', estimatedKwh: 10 });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await p.services.gateway.sagaStore.save({
      sagaId, type: 'RESERVE_AND_CHARGE', status: 'STARTED', environment: p.environment, correlationId: 'corr-orphan',
      input: { fleetId: 'FLEET-RICH', stationId: 'ST-CAL-01', connectorId: 'C2', estimatedKwh: 10, fastCharge: false },
      context: { powerKw: 60, amount: 9500 },
      steps: [
        { name: 'RESERVE_CONNECTOR', service: 'station-reservation-service', status: 'SUCCEEDED', attempts: 1, compensation: { name: 'RELEASE_CONNECTOR', status: 'NOT_REQUIRED', attempts: 0 } },
        { name: 'CHARGE_WALLET', service: 'billing-wallet-service', status: 'SUCCEEDED', attempts: 1, compensation: { name: 'REFUND_WALLET', status: 'NOT_REQUIRED', attempts: 0 } },
        { name: 'START_CHARGING', service: 'energy-dispatch-service', status: 'RUNNING', attempts: 1, compensation: { name: 'STOP_CHARGING', status: 'NOT_REQUIRED', attempts: 0 } },
        { name: 'CONFIRM_RESERVATION', service: 'station-reservation-service', status: 'PENDING', attempts: 0, compensation: null },
      ],
      failure: null, createdAt: old, updatedAt: old, finishedAt: null,
    });
    assert.equal(await balance('FLEET-RICH'), before - 9500);

    const { data, errors } = await p.graphql(`mutation { compensateSaga(sagaId: "${sagaId}") { status failure { code } } }`);
    assert.equal(errors, undefined);
    assert.equal(data.compensateSaga.status, 'COMPENSATED');
    assert.equal(data.compensateSaga.failure.code, 'SAGA_ORPHANED');
    assert.equal(await balance('FLEET-RICH'), before);
    assert.equal((await connector('ST-CAL-01', 'C2')).status, 'AVAILABLE');
  });
});

describe('Feature Flags por GraphQL', () => {
  test('setFeatureFlag cambia el comportamiento en caliente (tarifa dinamica)', async () => {
    const quote = async () => (await p.graphql(`{ quote(estimatedKwh: 10) { total surgeApplied } }`)).data.quote;
    assert.deepEqual(await quote(), { total: 9500, surgeApplied: false });

    const { data } = await p.graphql(`mutation { setFeatureFlag(name: "ENABLE_DYNAMIC_SURGE_PRICING", enabled: true) { name enabled updatedBy } }`);
    assert.equal(data.setFeatureFlag.enabled, true);
    assert.deepEqual(await quote(), { total: 14250, surgeApplied: true });

    await p.graphql(`mutation { setFeatureFlag(name: "ENABLE_DYNAMIC_SURGE_PRICING", enabled: false) { enabled } }`);
  });

  test('ultra-carga rechazada mientras ENABLE_FAST_CHARGE_BOOST este apagada', async () => {
    const input = { fleetId: 'FLEET-RICH', stationId: 'ST-MED-01', connectorId: 'C1', estimatedKwh: 10, fastCharge: true };
    const rejected = await reserve(input);
    assert.equal(rejected.errors[0].extensions.code, 'FAST_CHARGE_DISABLED');

    await p.setFlag('ENABLE_FAST_CHARGE_BOOST', true);
    const accepted = (await reserve(input)).data.reserveAndCharge;
    assert.equal(accepted.status, 'COMPLETED');
    assert.equal(accepted.amount, 11400); // 9500 + 20 % de recargo de ultra-carga
    await p.graphql(`mutation($id: ID!) { stopCharging(sagaId: $id) { status } }`, { id: accepted.sagaId });
    await p.setFlag('ENABLE_FAST_CHARGE_BOOST', false);
  });

  test('una flag inexistente no se puede crear por la API', async () => {
    const { errors } = await p.graphql(`mutation { setFeatureFlag(name: "NO_EXISTE", enabled: true) { name } }`);
    assert.equal(errors[0].extensions.code, 'FLAG_NOT_FOUND');
  });

  test('el historial de SAGAs incluye completadas y compensadas', async () => {
    const { data } = await p.graphql(`{ sagas(limit: 50) { sagaId status } }`);
    const statuses = new Set(data.sagas.map((s) => s.status));
    assert.ok(statuses.has('COMPLETED'));
    assert.ok(statuses.has('COMPENSATED'));
  });
});
