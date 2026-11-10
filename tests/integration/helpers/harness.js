// =============================================================================
// Arnes de pruebas de integracion
//
// Levanta la plataforma COMPLETA dentro del proceso de pruebas:
//   * crea tablas DynamoDB reales (en Floci) con un sufijo aleatorio, para no
//     tocar jamas las tablas de dev/test/prod;
//   * arranca los 3 microservicios y el gateway GraphQL en puertos libres;
//   * al terminar, apaga todo y borra las tablas.
//
// Nada esta simulado: las peticiones viajan por HTTP real y las escrituras
// condicionales las resuelve el motor de DynamoDB del emulador.
// =============================================================================
import { randomBytes } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { PutCommand, GetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildApp as buildStationApp } from '../../../services/station-reservation-service/src/app.js';
import { SEED_STATIONS } from '../../../services/station-reservation-service/src/seed.js';
import { buildApp as buildBillingApp } from '../../../services/billing-wallet-service/src/app.js';
import { buildApp as buildDispatchApp } from '../../../services/energy-dispatch-service/src/app.js';
import { buildApp as buildGatewayApp } from '../../../services/graphql-gateway/src/app.js';

process.env.AWS_ENDPOINT_URL ??= 'http://localhost:4566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

export const TEST_WALLETS = [
  { fleetId: 'FLEET-RICH', fleetName: 'Flota con fondos', balance: 500000 },
  { fleetId: 'FLEET-POOR', fleetName: 'Flota sin fondos', balance: 1000 },
];

export const ALL_FLAGS = [
  'ENABLE_DYNAMIC_SURGE_PRICING',
  'ENABLE_FAST_CHARGE_BOOST',
  'SIMULATE_CHARGER_HARDWARE_FAULT',
];

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, flush: async () => {} };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function startPlatform() {
  const environment = `it${randomBytes(4).toString('hex')}`;
  const tables = {
    reservations: `aegisvolt-reservations-${environment}`,
    billing: `aegisvolt-billing-${environment}`,
    dispatch: `aegisvolt-dispatch-${environment}`,
    sagas: `aegisvolt-sagas-${environment}`,
    featureFlags: `aegisvolt-feature-flags-${environment}`,
  };

  const raw = new DynamoDBClient({ region: process.env.AWS_REGION, endpoint: process.env.AWS_ENDPOINT_URL });
  const dynamo = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });

  // --- Tablas (misma estructura que declara Terraform) ------------------------
  const compositeKey = {
    AttributeDefinitions: [
      { AttributeName: 'pk', AttributeType: 'S' },
      { AttributeName: 'sk', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
  };
  for (const name of [tables.reservations, tables.billing, tables.dispatch, tables.sagas]) {
    await raw.send(new CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST', ...compositeKey }));
  }
  await raw.send(
    new CreateTableCommand({
      TableName: tables.featureFlags,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'flag_name', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'flag_name', KeyType: 'HASH' }],
    }),
  );
  for (const name of Object.values(tables)) {
    await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: name });
  }
  for (const flag of ALL_FLAGS) {
    await dynamo.send(
      new PutCommand({ TableName: tables.featureFlags, Item: { flag_name: flag, enabled: false, description: flag } }),
    );
  }

  // --- Servicios --------------------------------------------------------------
  // flagCacheTtlMs: 0 => cada lectura de flag va a DynamoDB (pruebas deterministas).
  const common = { environment, tables, dynamo, logger: silentLogger, flagCacheTtlMs: 0 };
  const stationSvc = buildStationApp(common);
  const billingSvc = buildBillingApp(common);
  const dispatchSvc = buildDispatchApp(common);
  await stationSvc.repository.seed(SEED_STATIONS);
  await billingSvc.repository.seed(TEST_WALLETS);

  const servers = {
    station: await listen(stationSvc.app),
    billing: await listen(billingSvc.app),
    dispatch: await listen(dispatchSvc.app),
  };
  const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;
  const urls = { station: urlOf(servers.station), billing: urlOf(servers.billing), dispatch: urlOf(servers.dispatch) };

  const gatewaySvc = await buildGatewayApp({ ...common, serviceUrls: urls });
  servers.gateway = await listen(gatewaySvc.app);
  urls.gateway = urlOf(servers.gateway);

  // --- Utilidades para los tests ----------------------------------------------
  async function http(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  }

  async function graphql(query, variables = {}, headers = {}) {
    const response = await fetch(`${urls.gateway}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ query, variables }),
    });
    return response.json();
  }

  async function setFlag(name, enabled) {
    await dynamo.send(new PutCommand({ TableName: tables.featureFlags, Item: { flag_name: name, enabled } }));
  }

  async function getItem(table, key) {
    const { Item } = await dynamo.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return Item ?? null;
  }

  async function stop() {
    await gatewaySvc.apollo.stop();
    await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => s.close(resolve))));
    for (const name of Object.values(tables)) {
      await raw.send(new DeleteTableCommand({ TableName: name })).catch(() => {});
    }
    raw.destroy();
  }

  return {
    environment,
    tables,
    urls,
    dynamo,
    http,
    graphql,
    setFlag,
    getItem,
    stop,
    services: { station: stationSvc, billing: billingSvc, dispatch: dispatchSvc, gateway: gatewaySvc },
  };
}
