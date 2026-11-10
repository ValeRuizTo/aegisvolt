// =============================================================================
// billing-wallet-service :: calculo de tarifas (logica pura, sin I/O)
//
// Dos Feature Flags modifican el precio:
//   ENABLE_DYNAMIC_SURGE_PRICING -> recargo de hora pico (x1.5)
//   ENABLE_FAST_CHARGE_BOOST     -> permite ultra-carga prioritaria (+20 %)
// =============================================================================

export const TARIFF = Object.freeze({
  currency: 'COP',
  pricePerKwh: 950, // tarifa base por kWh
  surgeMultiplier: 1.5, // recargo de tarifa dinamica en hora pico
  fastChargeSurchargeRate: 0.2, // recargo por reserva prioritaria de ultra-carga
});

/**
 * Horas consideradas "pico". Por defecto todo el dia, para que el efecto de la
 * flag sea visible en cualquier momento de una demostracion. En un despliegue
 * real se configuraria, por ejemplo, PEAK_HOURS="6-9,17-21".
 */
export function parsePeakHours(spec = '0-23') {
  const hours = new Set();
  for (const range of spec.split(',')) {
    const [from, to = from] = range.trim().split('-').map(Number);
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    for (let h = from; h <= to; h += 1) hours.add(h);
  }
  return hours;
}

/**
 * Calcula el valor estimado a retener en la billetera.
 * @returns {{ baseAmount, surgeMultiplier, surgeApplied, fastChargeFee, total, currency }}
 */
export function calculateQuote({
  estimatedKwh,
  fastCharge = false,
  surgePricingEnabled = false,
  hour = new Date().getHours(),
  peakHours = parsePeakHours(),
}) {
  if (!Number.isFinite(estimatedKwh) || estimatedKwh <= 0) {
    throw new RangeError('estimatedKwh debe ser un numero mayor que cero');
  }

  const baseAmount = Math.round(estimatedKwh * TARIFF.pricePerKwh);
  const surgeApplied = surgePricingEnabled && peakHours.has(hour);
  const surgeMultiplier = surgeApplied ? TARIFF.surgeMultiplier : 1;
  const energyAmount = Math.round(baseAmount * surgeMultiplier);
  const fastChargeFee = fastCharge ? Math.round(energyAmount * TARIFF.fastChargeSurchargeRate) : 0;

  return {
    currency: TARIFF.currency,
    pricePerKwh: TARIFF.pricePerKwh,
    estimatedKwh,
    baseAmount,
    surgeApplied,
    surgeMultiplier,
    fastChargeFee,
    total: energyAmount + fastChargeFee,
  };
}
