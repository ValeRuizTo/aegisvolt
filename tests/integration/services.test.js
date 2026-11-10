// =============================================================================
// PRUEBAS DE INTEGRACION - microservicios contra tablas DynamoDB reales (Floci)
//
// Verifican lo que una prueba unitaria no puede: que las ConditionExpression y
// las transacciones de DynamoDB se comportan como el diseno supone.
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

const connectorKey = (stationId, connectorId) => ({ pk: `STATION#${stationId}`, sk: `CONNECTOR#${connectorId}` });

describe('station-reservation-service (tabla reservations)', () => {
  test('lista las estaciones sembradas con sus conectores disponibles', async () => {
    const { status, body } = await p.http('GET', `${p.urls.station}/stations`);
    assert.equal(status, 200);
    assert.equal(body.stations.length, 3);
    const bogota = body.stations.find((s) => s.stationId === 'ST-BOG-01');
    assert.equal(bogota.connectors.length, 4);
    assert.ok(bogota.connectors.every((c) => c.status === 'AVAILABLE'));
  });

  test('reservar cambia el conector a RESERVED en DynamoDB', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations`, {
      sagaId: 'saga-st-1', stationId: 'ST-BOG-01', connectorId: 'C4', fleetId: 'FLEET-RICH',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.reservation.status, 'RESERVED');

    const item = await p.getItem(p.tables.reservations, connectorKey('ST-BOG-01', 'C4'));
    assert.equal(item.status, 'RESERVED');
    assert.equal(item.reservedBy, 'saga-st-1');
    assert.ok(item.lockExpiresAt, 'el bloqueo temporal tiene vencimiento');
  });

  test('IDEMPOTENCIA: repetir la misma reserva no falla ni duplica', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations`, {
      sagaId: 'saga-st-1', stationId: 'ST-BOG-01', connectorId: 'C4', fleetId: 'FLEET-RICH',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.idempotentReplay, true);
  });

  test('otra SAGA no puede reservar un conector ocupado (409)', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations`, {
      sagaId: 'saga-st-2', stationId: 'ST-BOG-01', connectorId: 'C4', fleetId: 'FLEET-RICH',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CONNECTOR_NOT_AVAILABLE');
  });

  test('dos reservas simultaneas del mismo conector: solo una gana', async () => {
    const attempt = (sagaId) =>
      p.http('POST', `${p.urls.station}/reservations`, {
        sagaId, stationId: 'ST-CAL-01', connectorId: 'C2', fleetId: 'FLEET-RICH',
      });
    const results = await Promise.all([attempt('race-a'), attempt('race-b'), attempt('race-c')]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409]);
  });

  test('COMPENSACION: release devuelve el conector a AVAILABLE', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations/saga-st-1/release`, { reason: 'TEST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.released, true);
    assert.equal(res.body.reservation.status, 'RELEASED');

    const item = await p.getItem(p.tables.reservations, connectorKey('ST-BOG-01', 'C4'));
    assert.equal(item.status, 'AVAILABLE');
    assert.equal(item.reservedBy, undefined);
  });

  test('IDEMPOTENCIA: una compensacion duplicada no libera la reserva de OTRA saga', async () => {
    // Otra SAGA toma el conector que saga-st-1 acaba de liberar...
    const other = await p.http('POST', `${p.urls.station}/reservations`, {
      sagaId: 'saga-st-3', stationId: 'ST-BOG-01', connectorId: 'C4', fleetId: 'FLEET-RICH',
    });
    assert.equal(other.status, 201);

    // ...y llega OTRA VEZ la compensacion de saga-st-1 (mensaje duplicado).
    const duplicate = await p.http('POST', `${p.urls.station}/reservations/saga-st-1/release`, { reason: 'TEST' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.alreadyReleased, true);

    const item = await p.getItem(p.tables.reservations, connectorKey('ST-BOG-01', 'C4'));
    assert.equal(item.status, 'RESERVED', 'el conector sigue siendo de saga-st-3');
    assert.equal(item.reservedBy, 'saga-st-3');
    await p.http('POST', `${p.urls.station}/reservations/saga-st-3/release`, {});
  });

  test('compensar una SAGA que nunca reservo responde OK (nada que deshacer)', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations/no-existe/release`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyReleased, true);
  });

  test('ultra-carga exige un conector de 150 kW o mas', async () => {
    const res = await p.http('POST', `${p.urls.station}/reservations`, {
      sagaId: 'saga-st-4', stationId: 'ST-BOG-01', connectorId: 'C4', fleetId: 'FLEET-RICH', fastCharge: true,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CONNECTOR_NOT_ULTRA_FAST');
  });
});

describe('billing-wallet-service (tabla billing)', () => {
  const walletKey = { pk: 'WALLET#FLEET-RICH', sk: 'BALANCE' };

  test('cobrar descuenta el saldo y registra el movimiento', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges`, {
      sagaId: 'saga-bi-1', fleetId: 'FLEET-RICH', estimatedKwh: 20,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.transaction.amount, 19000); // 20 kWh x 950 COP
    assert.equal(res.body.wallet.balance, 481000);

    const tx = await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-RICH', sk: 'TX#saga-bi-1#CHARGE' });
    assert.equal(tx.type, 'CHARGE');
    assert.ok(tx.correlationId, 'el movimiento guarda el correlation_id');
  });

  test('IDEMPOTENCIA: un cobro repetido no descuenta dos veces', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges`, {
      sagaId: 'saga-bi-1', fleetId: 'FLEET-RICH', estimatedKwh: 20,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.idempotentReplay, true);
    assert.equal((await p.getItem(p.tables.billing, walletKey)).balance, 481000);
  });

  test('fondos insuficientes: 402 y el saldo no cambia', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges`, {
      sagaId: 'saga-bi-2', fleetId: 'FLEET-POOR', estimatedKwh: 20,
    });
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'INSUFFICIENT_FUNDS');
    assert.equal((await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-POOR', sk: 'BALANCE' })).balance, 1000);
    assert.equal(await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-POOR', sk: 'TX#saga-bi-2#CHARGE' }), null);
  });

  test('COMPENSACION: el reembolso restaura el saldo y deja evento de reversion', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges/saga-bi-1/refund`, {
      fleetId: 'FLEET-RICH', reason: 'CHARGER_HARDWARE_FAULT',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.refunded, true);
    assert.equal(res.body.wallet.balance, 500000);

    const refund = await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-RICH', sk: 'TX#saga-bi-1#REFUND' });
    assert.equal(refund.type, 'REFUND');
    assert.equal(refund.amount, 19000);
    assert.equal(refund.reason, 'CHARGER_HARDWARE_FAULT');
    const charge = await p.getItem(p.tables.billing, { pk: 'WALLET#FLEET-RICH', sk: 'TX#saga-bi-1#CHARGE' });
    assert.equal(charge.status, 'REFUNDED');
  });

  test('IDEMPOTENCIA: procesar el reembolso dos veces no devuelve el dinero dos veces', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges/saga-bi-1/refund`, { fleetId: 'FLEET-RICH' });
    assert.equal(res.status, 200);
    assert.equal(res.body.refunded, false);
    assert.equal(res.body.alreadyRefunded, true);
    assert.equal((await p.getItem(p.tables.billing, walletKey)).balance, 500000);
  });

  test('reembolsos simultaneos de la misma SAGA: solo uno se aplica', async () => {
    await p.http('POST', `${p.urls.billing}/charges`, { sagaId: 'saga-bi-3', fleetId: 'FLEET-RICH', estimatedKwh: 10 });
    const refund = () => p.http('POST', `${p.urls.billing}/charges/saga-bi-3/refund`, { fleetId: 'FLEET-RICH' });
    const results = await Promise.all([refund(), refund(), refund(), refund()]);
    assert.equal(results.filter((r) => r.body.refunded === true).length, 1);
    assert.equal((await p.getItem(p.tables.billing, walletKey)).balance, 500000);
  });

  test('reembolsar una SAGA que nunca cobro responde OK sin tocar el saldo', async () => {
    const res = await p.http('POST', `${p.urls.billing}/charges/nunca-cobro/refund`, { fleetId: 'FLEET-RICH' });
    assert.equal(res.status, 200);
    assert.equal(res.body.nothingToRefund, true);
    assert.equal((await p.getItem(p.tables.billing, walletKey)).balance, 500000);
  });

  test('la flag de tarifa dinamica cambia la cotizacion sin reiniciar el servicio', async () => {
    const before = await p.http('POST', `${p.urls.billing}/quotes`, { estimatedKwh: 10 });
    assert.equal(before.body.quote.total, 9500);
    assert.equal(before.body.quote.surgeApplied, false);

    await p.setFlag('ENABLE_DYNAMIC_SURGE_PRICING', true);
    const after = await p.http('POST', `${p.urls.billing}/quotes`, { estimatedKwh: 10 });
    assert.equal(after.body.quote.surgeApplied, true);
    assert.equal(after.body.quote.total, 14250); // x1.5
    await p.setFlag('ENABLE_DYNAMIC_SURGE_PRICING', false);
  });
});

describe('energy-dispatch-service (tabla dispatch)', () => {
  const session = (sagaId) => ({
    sagaId, stationId: 'ST-MED-01', connectorId: 'C1', fleetId: 'FLEET-RICH', powerKw: 180, targetKwh: 30,
  });

  test('activar el cargador crea la sesion ACTIVE y la primera muestra de telemetria', async () => {
    const res = await p.http('POST', `${p.urls.dispatch}/sessions`, session('saga-di-1'));
    assert.equal(res.status, 201);
    assert.equal(res.body.session.status, 'ACTIVE');

    const telemetry = await p.http('GET', `${p.urls.dispatch}/sessions/saga-di-1/telemetry`);
    assert.equal(telemetry.body.telemetry.length, 1);
    assert.equal(telemetry.body.telemetry[0].sampleIndex, 0);
  });

  test('IDEMPOTENCIA: activar dos veces no crea otra sesion', async () => {
    const res = await p.http('POST', `${p.urls.dispatch}/sessions`, session('saga-di-1'));
    assert.equal(res.status, 200);
    assert.equal(res.body.idempotentReplay, true);
  });

  test('el registro periodico de telemetria no duplica muestras entre replicas', async () => {
    const { recordTelemetryTick } = p.services.dispatch;
    // Dos "replicas" intentan escribir la misma muestra al mismo tiempo.
    await Promise.all([recordTelemetryTick(), recordTelemetryTick()]);
    const { body } = await p.http('GET', `${p.urls.dispatch}/sessions/saga-di-1/telemetry`);
    const indexes = body.telemetry.map((s) => s.sampleIndex);
    assert.equal(new Set(indexes).size, indexes.length, 'no hay indices repetidos');
  });

  test('con SIMULATE_CHARGER_HARDWARE_FAULT activa el cargador falla (503)', async () => {
    await p.setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    const res = await p.http('POST', `${p.urls.dispatch}/sessions`, session('saga-di-2'));
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'CHARGER_HARDWARE_FAULT');

    const item = await p.getItem(p.tables.dispatch, { pk: 'SESSION#saga-di-2', sk: 'META' });
    assert.equal(item.status, 'FAILED');
    await p.setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);
  });

  test('detener la sesion es idempotente', async () => {
    const first = await p.http('POST', `${p.urls.dispatch}/sessions/saga-di-1/stop`, {});
    assert.equal(first.body.stopped, true);
    assert.equal(first.body.session.status, 'STOPPED');
    const second = await p.http('POST', `${p.urls.dispatch}/sessions/saga-di-1/stop`, {});
    assert.equal(second.body.alreadyStopped, true);
  });
});

describe('aspectos transversales', () => {
  test('/health informa servicio, ambiente y version', async () => {
    const { body } = await p.http('GET', `${p.urls.billing}/health`);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'billing-wallet-service');
    assert.equal(body.environment, p.environment);
  });

  test('el correlation_id recibido se devuelve en la respuesta', async () => {
    const response = await fetch(`${p.urls.station}/stations`, { headers: { 'x-correlation-id': 'corr-123' } });
    assert.equal(response.headers.get('x-correlation-id'), 'corr-123');
    await response.arrayBuffer();
  });
});
