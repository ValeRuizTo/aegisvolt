// =============================================================================
// PRUEBAS DE EXTREMO A EXTREMO (E2E)
//
// Recorren la plataforma YA DESPLEGADA entrando por la misma puerta que el
// usuario: el servidor del frontend (y, en un ambiente real, el API Gateway).
//
//   E2E_BASE_URL=http://localhost:8088 npm run test:e2e           (stack docker compose del PR)
//   E2E_BASE_URL=http://localhost:4566/execute-api/aegisvolt-dev/dev npm run test:e2e
//
// A diferencia de las de integracion, aqui los servicios corren en sus
// contenedores reales, con su Dockerfile, su red y su configuracion.
//
// El escenario cambia flags; por eso no se ejecuta contra prod.
// =============================================================================
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = (process.env.E2E_BASE_URL ?? 'http://localhost:8088').replace(/\/$/, '');
const FLEET = process.env.E2E_FLEET ?? 'FLEET-ANDES';
const POOR_FLEET = process.env.E2E_POOR_FLEET ?? 'FLEET-CARIBE';

async function graphql(query, variables = {}) {
  const response = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  assert.equal(response.status, 200, `GraphQL respondio HTTP ${response.status}`);
  return response.json();
}

const RESERVE = `
  mutation($input: ReserveAndChargeInput!) {
    reserveAndCharge(input: $input) {
      sagaId status correlationId amount failure { step code }
      steps { name status compensation { name status } }
    }
  }`;

const setFlag = (name, enabled) =>
  graphql(`mutation($name: String!, $enabled: Boolean!) { setFeatureFlag(name: $name, enabled: $enabled) { enabled } }`, { name, enabled });

const flagsNow = async () =>
  Object.fromEntries((await graphql(`{ featureFlags { name enabled } }`)).data.featureFlags.map((f) => [f.name, f.enabled]));

const balanceOf = async (fleetId) =>
  (await graphql(`query($id: ID!) { wallet(fleetId: $id) { balance } }`, { id: fleetId })).data.wallet.balance;

const connectorStatus = async (stationId, connectorId) => {
  const { data } = await graphql(`{ stations { stationId connectors { connectorId status } } }`);
  return data.stations.find((s) => s.stationId === stationId).connectors.find((c) => c.connectorId === connectorId).status;
};

/** Primer conector disponible (los E2E no asumen un estado inicial limpio). */
async function freeConnector() {
  const { data } = await graphql(`{ stations { stationId connectors { connectorId status powerKw } } }`);
  for (const station of data.stations) {
    const connector = station.connectors.find((c) => c.status === 'AVAILABLE');
    if (connector) return { stationId: station.stationId, connectorId: connector.connectorId };
  }
  assert.fail('No hay conectores disponibles para ejecutar los E2E');
}

async function waitUntilReady() {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const { data } = await graphql(`{ environment { services { status } } }`);
      if (data.environment.services.every((s) => s.status === 'ok')) return;
      lastError = new Error('servicios aun no saludables');
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`La plataforma no estuvo lista en 90 s (${BASE_URL}): ${lastError?.message}`);
}

let originalFlags;
before(async () => {
  await waitUntilReady();
  originalFlags = await flagsNow();
});
after(async () => {
  // Se restauran las flags tal como estaban antes de las pruebas.
  for (const [name, enabled] of Object.entries(originalFlags ?? {})) await setFlag(name, enabled);
});

describe('frontend', () => {
  test('sirve la aplicacion web', async () => {
    const response = await fetch(`${BASE_URL}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /AegisVolt/);
  });

  test('sirve el JavaScript compilado que referencia el index.html', async () => {
    const html = await (await fetch(`${BASE_URL}/`)).text();
    const asset = html.match(/assets\/index-[\w-]+\.js/)?.[0];
    assert.ok(asset, 'index.html referencia un bundle JS');
    const response = await fetch(`${BASE_URL}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
  });
});

describe('consulta del tablero (la misma que hace el frontend)', () => {
  test('devuelve ambiente, estaciones, billeteras y flags', async () => {
    const { data, errors } = await graphql(`{
      environment { name version services { name status } }
      stations { stationId availableConnectors connectors { connectorId status } }
      wallets { fleetId balance }
      featureFlags { name enabled }
      sagas(limit: 5) { sagaId status }
    }`);
    assert.equal(errors, undefined);
    assert.equal(data.environment.services.length, 4);
    assert.ok(data.stations.length >= 3);
    assert.ok(data.wallets.some((w) => w.fleetId === FLEET));
    assert.equal(data.featureFlags.length, 3);
  });
});

describe('flujo completo: reservar, cargar y detener', () => {
  let saga;
  let target;
  let balanceBefore;

  test('la SAGA se completa y el usuario ve la carga activa', async () => {
    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);
    await new Promise((resolve) => setTimeout(resolve, 3500)); // TTL del cache de flags
    target = await freeConnector();
    balanceBefore = await balanceOf(FLEET);

    const { data, errors } = await graphql(RESERVE, { input: { fleetId: FLEET, ...target, estimatedKwh: 10 } });
    assert.equal(errors, undefined);
    saga = data.reserveAndCharge;
    assert.equal(saga.status, 'COMPLETED');
    assert.ok(saga.correlationId);
    assert.equal(await connectorStatus(target.stationId, target.connectorId), 'CHARGING');
    assert.equal(await balanceOf(FLEET), balanceBefore - saga.amount);
  });

  test('la sesion aparece entre las cargas en curso con telemetria', async () => {
    const { data } = await graphql(`{ chargingSessions(status: ACTIVE) { sagaId latestTelemetry { kwhDelivered } } }`);
    const session = data.chargingSessions.find((s) => s.sagaId === saga.sagaId);
    assert.ok(session, 'la sesion esta activa');
    assert.ok(session.latestTelemetry);
  });

  test('detener la carga libera el conector', async () => {
    const { data, errors } = await graphql(`mutation($id: ID!) { stopCharging(sagaId: $id) { status } }`, { id: saga.sagaId });
    assert.equal(errors, undefined);
    assert.equal(data.stopCharging.status, 'STOPPED');
    assert.equal(await connectorStatus(target.stationId, target.connectorId), 'AVAILABLE');
  });
});

describe('fallo inducido por Feature Flag: rollback distribuido', () => {
  test('con SIMULATE_CHARGER_HARDWARE_FAULT la SAGA se compensa y nada queda a medias', async () => {
    const target = await freeConnector();
    const balanceBefore = await balanceOf(FLEET);

    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', true);
    await new Promise((resolve) => setTimeout(resolve, 3500)); // TTL del cache de flags
    const { data, errors } = await graphql(RESERVE, { input: { fleetId: FLEET, ...target, estimatedKwh: 10 } });
    await setFlag('SIMULATE_CHARGER_HARDWARE_FAULT', false);

    assert.equal(errors, undefined);
    const saga = data.reserveAndCharge;
    assert.equal(saga.status, 'COMPENSATED');
    assert.equal(saga.failure.step, 'START_CHARGING');
    assert.equal(saga.failure.code, 'CHARGER_HARDWARE_FAULT');

    const compensated = saga.steps.filter((s) => s.compensation?.status === 'COMPENSATED').map((s) => s.compensation.name);
    assert.deepEqual(compensated.sort(), ['REFUND_WALLET', 'RELEASE_CONNECTOR']);

    assert.equal(await balanceOf(FLEET), balanceBefore, 'el saldo volvio a su valor');
    assert.equal(await connectorStatus(target.stationId, target.connectorId), 'AVAILABLE', 'el conector quedo libre');

    const history = await graphql(`query($id: ID!) { saga(sagaId: $id) { status } wallet(fleetId: "${FLEET}") { transactions { sagaId type } } }`, { id: saga.sagaId });
    assert.equal(history.data.saga.status, 'COMPENSATED');
    const types = history.data.wallet.transactions.filter((t) => t.sagaId === saga.sagaId).map((t) => t.type).sort();
    assert.deepEqual(types, ['CHARGE', 'REFUND'], 'quedan el cobro y su evento de reversion');
  });
});

describe('fondos insuficientes', () => {
  test('la SAGA falla en el cobro y solo libera el conector', async () => {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const target = await freeConnector();
    const { data } = await graphql(RESERVE, { input: { fleetId: POOR_FLEET, ...target, estimatedKwh: 200 } });
    const saga = data.reserveAndCharge;
    assert.equal(saga.status, 'COMPENSATED');
    assert.equal(saga.failure.code, 'INSUFFICIENT_FUNDS');
    assert.equal(await connectorStatus(target.stationId, target.connectorId), 'AVAILABLE');
  });
});

describe('Feature Flags en caliente', () => {
  test('activar la tarifa dinamica cambia la cotizacion sin redesplegar', async () => {
    const quote = async () => (await graphql(`{ quote(estimatedKwh: 10) { total surgeApplied } }`)).data.quote;

    await setFlag('ENABLE_DYNAMIC_SURGE_PRICING', false);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.deepEqual(await quote(), { total: 9500, surgeApplied: false });

    await setFlag('ENABLE_DYNAMIC_SURGE_PRICING', true);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.deepEqual(await quote(), { total: 14250, surgeApplied: true });
  });
});
