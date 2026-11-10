// =============================================================================
// Contexto de la peticion (correlation_id)
//
// AsyncLocalStorage guarda datos "por peticion" sin tener que pasarlos como
// parametro por cada funcion. El middleware HTTP abre el contexto con el
// correlation_id y cualquier log o llamada saliente hecha durante esa peticion
// lo recupera con currentContext().
// =============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage();

/** Ejecuta fn dentro de un contexto con los campos indicados. */
export function runWithContext(fields, fn) {
  return storage.run({ ...fields }, fn);
}

/** Contexto de la peticion en curso ({} si no hay ninguna). */
export function currentContext() {
  return storage.getStore() ?? {};
}

/** Agrega campos al contexto actual (p. ej. saga_id al iniciar una SAGA). */
export function addToContext(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

export function newCorrelationId() {
  return randomUUID();
}

export const CORRELATION_HEADER = 'x-correlation-id';
