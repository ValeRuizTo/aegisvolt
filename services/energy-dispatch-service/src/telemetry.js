// =============================================================================
// energy-dispatch-service :: simulacion de telemetria (logica pura, sin I/O)
//
// No hay un cargador fisico, asi que la telemetria se calcula a partir del
// tiempo transcurrido desde que inicio la sesion. La muestra numero N es
// siempre la misma para una sesion dada (funcion determinista): por eso varias
// replicas del servicio pueden generar la misma muestra sin crear duplicados.
// =============================================================================

export const SAMPLE_INTERVAL_SECONDS = 5;

// Aceleracion de la simulacion: 1 segundo real = 60 segundos de carga, para que
// en una demostracion se vea avanzar la energia entregada.
export const TIME_ACCELERATION = 60;

/** Numero de muestra que corresponde al instante "now". */
export function sampleIndexAt(startedAtIso, now = new Date()) {
  const elapsedSeconds = (now.getTime() - new Date(startedAtIso).getTime()) / 1000;
  return Math.max(0, Math.floor(elapsedSeconds / SAMPLE_INTERVAL_SECONDS));
}

/** Calcula la muestra N de una sesion. */
export function buildSample(session, index) {
  const simulatedHours = (index * SAMPLE_INTERVAL_SECONDS * TIME_ACCELERATION) / 3600;
  const delivered = Math.min(session.targetKwh, session.powerKw * simulatedHours);
  const finished = delivered >= session.targetKwh;

  // Variaciones pequenas y repetibles (dependen solo del indice).
  const ripple = Math.sin(index * 1.7) * 0.02;
  const powerKw = finished ? 0 : round(session.powerKw * (0.97 + ripple), 1);
  const voltage = round(400 + Math.sin(index) * 6, 1);
  const currentAmps = finished ? 0 : round((powerKw * 1000) / voltage, 1);

  return {
    sampleIndex: index,
    recordedAt: new Date(new Date(session.startedAt).getTime() + index * SAMPLE_INTERVAL_SECONDS * 1000).toISOString(),
    kwhDelivered: round(delivered, 2),
    powerKw,
    voltage,
    currentAmps,
    connectorTempC: round(28 + Math.min(index, 20) * 0.6 + ripple * 50, 1),
    progressPercent: round((delivered / session.targetKwh) * 100, 1),
    finished,
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
