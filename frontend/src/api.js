// =============================================================================
// Cliente GraphQL minimo (fetch) + consultas del frontend
//
// La URL del endpoint es RELATIVA a la pagina. Como cada ambiente sirve el
// frontend bajo su propio prefijo del API Gateway, el frontend de dev solo
// puede hablar con el GraphQL de dev, el de prod con el de prod, etc.:
//
//   .../execute-api/aegisvolt-dev/dev/     ->  .../aegisvolt-dev/dev/graphql
//   .../execute-api/aegisvolt-prod/prod/   ->  .../aegisvolt-prod/prod/graphql
// =============================================================================

function graphqlEndpoint() {
  if (import.meta.env.VITE_GRAPHQL_URL) return import.meta.env.VITE_GRAPHQL_URL;
  const { origin, pathname } = window.location;
  const base = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return `${origin}${base}graphql`;
}

export const GRAPHQL_URL = graphqlEndpoint();

export class GraphQLRequestError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function gql(query, variables = {}) {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok && response.status >= 500) {
    throw new GraphQLRequestError(`El gateway respondio HTTP ${response.status}`, 'GATEWAY_ERROR');
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    const [first] = payload.errors;
    throw new GraphQLRequestError(first.message, first.extensions?.code);
  }
  return payload.data;
}

const SAGA_FIELDS = `
  sagaId status correlationId environment fleetId stationId connectorId estimatedKwh fastCharge amount
  createdAt finishedAt
  failure { step code message }
  steps { name status service attempts error compensation { name status attempts error } }
`;

// Una sola consulta alimenta todo el tablero; se repite cada pocos segundos.
export const DASHBOARD_QUERY = `
  query Dashboard {
    environment { name version track services { name status version track } }
    stations {
      stationId name city address availableConnectors
      connectors { connectorId type powerKw ultraFast status reservedBy }
    }
    wallets { fleetId fleetName balance currency }
    featureFlags { name enabled description updatedAt updatedBy }
    sagas(limit: 15) { ${SAGA_FIELDS} }
    chargingSessions(status: ACTIVE) {
      sagaId stationId connectorId fleetId powerKw targetKwh startedAt
      latestTelemetry { kwhDelivered powerKw voltage currentAmps connectorTempC progressPercent finished }
    }
  }
`;

export const QUOTE_QUERY = `
  query Quote($estimatedKwh: Float!, $fastCharge: Boolean) {
    quote(estimatedKwh: $estimatedKwh, fastCharge: $fastCharge) {
      currency pricePerKwh baseAmount surgeApplied surgeMultiplier fastChargeFee total
    }
  }
`;

export const RESERVE_MUTATION = `
  mutation Reserve($input: ReserveAndChargeInput!) {
    reserveAndCharge(input: $input) { ${SAGA_FIELDS} }
  }
`;

export const STOP_MUTATION = `mutation Stop($sagaId: ID!) { stopCharging(sagaId: $sagaId) { sagaId status } }`;

export const SET_FLAG_MUTATION = `
  mutation SetFlag($name: String!, $enabled: Boolean!) {
    setFeatureFlag(name: $name, enabled: $enabled) { name enabled updatedAt updatedBy }
  }
`;

export const TOPUP_MUTATION = `
  mutation TopUp($fleetId: ID!, $amount: Int!) { topUpWallet(fleetId: $fleetId, amount: $amount) { fleetId balance } }
`;

export const money = (value, currency = 'COP') =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value ?? 0);

export const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-CO', { hour12: false }) : '—');
