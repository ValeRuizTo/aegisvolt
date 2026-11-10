// =============================================================================
// Clientes HTTP hacia los tres microservicios
//
//  * Propagan la cabecera x-correlation-id: asi los logs de los cuatro
//    servicios comparten el mismo identificador para una misma SAGA.
//  * Timeout por llamada: un servicio colgado no bloquea la SAGA para siempre.
//  * Traducen cualquier fallo a ServiceError, con dos datos que el orquestador
//    necesita para decidir:
//      - code       : codigo de negocio (INSUFFICIENT_FUNDS, CHARGER_HARDWARE_FAULT...)
//      - ambiguous  : true si NO se sabe si el servicio alcanzo a ejecutar la
//                     operacion (timeout, red caida, error 5xx generico).
// =============================================================================
import { CORRELATION_HEADER, currentContext } from '@aegisvolt/common';

export class ServiceError extends Error {
  constructor({ service, code, message, status = null, ambiguous = false, details }) {
    super(message);
    this.name = 'ServiceError';
    this.service = service;
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
    this.details = details;
  }
}

function createHttpClient({ service, baseUrl, timeoutMs = 5000, fetchImpl = fetch }) {
  async function request(method, path, body) {
    const { correlationId } = currentContext();
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(correlationId ? { [CORRELATION_HEADER]: correlationId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Sin respuesta: no sabemos si el servicio proceso la peticion.
      throw new ServiceError({
        service,
        code: err.name === 'TimeoutError' ? 'SERVICE_TIMEOUT' : 'SERVICE_UNAVAILABLE',
        message: `${service} no respondio (${err.name}: ${err.message})`,
        ambiguous: true,
      });
    }

    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;

    const code = payload?.error?.code;
    throw new ServiceError({
      service,
      code: code ?? `HTTP_${response.status}`,
      message: payload?.error?.message ?? `${service} respondio HTTP ${response.status}`,
      status: response.status,
      // Un 5xx sin codigo de negocio (o un fallo interno) es ambiguo; un rechazo
      // de negocio (4xx, o 503 CHARGER_HARDWARE_FAULT) es una respuesta definitiva.
      ambiguous: response.status >= 500 && (!code || code === 'INTERNAL_ERROR' || code === 'INJECTED_FAULT'),
      details: payload?.error?.details,
    });
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
  };
}

export function createServiceClients({ urls, timeoutMs, fetchImpl }) {
  const station = createHttpClient({ service: 'station-reservation-service', baseUrl: urls.station, timeoutMs, fetchImpl });
  const billing = createHttpClient({ service: 'billing-wallet-service', baseUrl: urls.billing, timeoutMs, fetchImpl });
  const dispatch = createHttpClient({ service: 'energy-dispatch-service', baseUrl: urls.dispatch, timeoutMs, fetchImpl });
  const id = encodeURIComponent;

  return {
    station: {
      health: () => station.get('/health'),
      listStations: async () => (await station.get('/stations')).stations,
      reserve: (body) => station.post('/reservations', body),
      confirm: (sagaId) => station.post(`/reservations/${id(sagaId)}/confirm`),
      release: (sagaId, body) => station.post(`/reservations/${id(sagaId)}/release`, body),
      complete: (sagaId) => station.post(`/reservations/${id(sagaId)}/complete`),
    },
    billing: {
      health: () => billing.get('/health'),
      listWallets: async () => (await billing.get('/wallets')).wallets,
      getWallet: (fleetId) => billing.get(`/wallets/${id(fleetId)}`),
      topUp: async (fleetId, amount) => (await billing.post(`/wallets/${id(fleetId)}/topup`, { amount })).wallet,
      quote: async (body) => (await billing.post('/quotes', body)).quote,
      charge: (body) => billing.post('/charges', body),
      refund: (sagaId, body) => billing.post(`/charges/${id(sagaId)}/refund`, body),
    },
    dispatch: {
      health: () => dispatch.get('/health'),
      start: (body) => dispatch.post('/sessions', body),
      stop: (sagaId, body) => dispatch.post(`/sessions/${id(sagaId)}/stop`, body),
      listSessions: async (status) =>
        (await dispatch.get(`/sessions${status ? `?status=${id(status)}` : ''}`)).sessions,
      getSession: async (sagaId) => (await dispatch.get(`/sessions/${id(sagaId)}`)).session,
      telemetry: async (sagaId, limit = 30) =>
        (await dispatch.get(`/sessions/${id(sagaId)}/telemetry?limit=${limit}`)).telemetry,
    },
  };
}
