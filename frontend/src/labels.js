// =============================================================================
// Textos de la interfaz en lenguaje del operador de flota.
//
// El backend habla en terminos tecnicos (pasos de la SAGA, compensaciones,
// codigos de error). Aqui se traducen a lo que un despachador entiende. Los
// nombres tecnicos siguen visibles en "Ver detalle tecnico".
// =============================================================================

export const ENV_NAMES = {
  dev: 'Desarrollo',
  test: 'Pruebas',
  prod: 'Producción',
};

export const CONNECTOR_STATUS = {
  AVAILABLE: 'Libre',
  RESERVED: 'Reservado',
  CHARGING: 'Cargando',
};

// Pasos de la operacion "reservar y cargar", en el orden en que ocurren.
export const STEP_LABELS = {
  RESERVE_CONNECTOR: 'Conector reservado',
  CHARGE_WALLET: 'Saldo retenido',
  START_CHARGING: 'Cargador encendido',
  CONFIRM_RESERVATION: 'Carga confirmada',
};

// El paso que fallo, contado en positivo para el operador.
export const FAILED_LABELS = {
  RESERVE_CONNECTOR: 'No se pudo reservar el conector',
  CHARGE_WALLET: 'No se pudo retener el saldo',
  START_CHARGING: 'El cargador no encendió',
  CONFIRM_RESERVATION: 'No se pudo confirmar la carga',
};

// Pasos a los que nunca se llego.
export const PENDING_LABELS = {
  RESERVE_CONNECTOR: 'Reservar el conector',
  CHARGE_WALLET: 'Retener el saldo',
  START_CHARGING: 'Encender el cargador',
  CONFIRM_RESERVATION: 'Confirmar la carga',
};

// Lo que se deshizo automaticamente cuando la operacion no pudo completarse.
export const UNDO_LABELS = {
  RELEASE_CONNECTOR: 'Conector liberado',
  REFUND_WALLET: 'Dinero devuelto',
  STOP_CHARGING: 'Cargador apagado',
};

// Estado de una operacion en el historial.
export const OPERATION_STATUS = {
  STARTED: { label: 'En proceso', tone: 'info' },
  COMPLETED: { label: 'Carga iniciada', tone: 'ok' },
  COMPENSATING: { label: 'Cancelando', tone: 'warn' },
  COMPENSATED: { label: 'Cancelada', tone: 'warn' },
  COMPENSATION_FAILED: { label: 'Requiere revisión', tone: 'bad' },
};

// Motivo por el que una operacion se cancelo, segun el codigo del backend.
const FAILURE_REASONS = {
  CHARGER_HARDWARE_FAULT: 'El cargador reportó una falla y no pudo encenderse.',
  INSUFFICIENT_FUNDS: 'La flota no tenía saldo suficiente.',
  CONNECTOR_NOT_AVAILABLE: 'Otro vehículo tomó ese conector justo antes.',
  CONNECTOR_NOT_ULTRA_FAST: 'Ese conector no admite carga prioritaria.',
  FAST_CHARGE_DISABLED: 'La carga prioritaria no está disponible en este ambiente.',
  WALLET_NOT_FOUND: 'No encontramos la billetera de la flota.',
  SAGA_ORPHANED: 'La operación quedó interrumpida y se canceló al revisarla.',
  SERVICE_TIMEOUT: 'Uno de nuestros sistemas tardó demasiado en responder.',
  SERVICE_UNAVAILABLE: 'Uno de nuestros sistemas no estaba disponible.',
};

export function failureReason(code) {
  return FAILURE_REASONS[code] ?? 'Algo falló al iniciar la carga.';
}

/** Que se deshizo, en una frase: "Liberamos el conector y devolvimos el dinero." */
export function undoSummary(operation) {
  const undone = new Set(
    operation.steps.filter((s) => s.compensation?.status === 'COMPENSATED').map((s) => s.compensation.name),
  );
  const refunded = undone.has('REFUND_WALLET');
  const released = undone.has('RELEASE_CONNECTOR');
  if (refunded && released) return 'Liberamos el conector y devolvimos el dinero a la billetera.';
  if (released) return 'No se cobró nada y el conector quedó libre.';
  if (refunded) return 'Devolvimos el dinero a la billetera.';
  return 'No se cobró nada.';
}

// Ajustes del ambiente (feature flags) en palabras del operador.
export const FLAG_TEXTS = {
  ENABLE_DYNAMIC_SURGE_PRICING: {
    title: 'Tarifa de hora pico',
    description: 'Cobra 1,5 veces la tarifa normal en las horas de mayor demanda.',
  },
  ENABLE_FAST_CHARGE_BOOST: {
    title: 'Carga prioritaria',
    description: 'Permite reservar conectores de 150 kW o más con prioridad, por un 20 % adicional.',
  },
  SIMULATE_CHARGER_HARDWARE_FAULT: {
    title: 'Simular averías',
    description: 'Modo de pruebas: los cargadores fallan al encender y la carga se cancela sola.',
  },
};

export const FLAG_ORDER = [
  'ENABLE_DYNAMIC_SURGE_PRICING',
  'ENABLE_FAST_CHARGE_BOOST',
  'SIMULATE_CHARGER_HARDWARE_FAULT',
];
