// PRUEBAS UNITARIAS - calculo de tarifas (logica pura)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateQuote, parsePeakHours, TARIFF } from '../src/pricing.js';

describe('calculateQuote', () => {
  test('tarifa base = kWh x precio por kWh', () => {
    const quote = calculateQuote({ estimatedKwh: 20 });
    assert.equal(quote.baseAmount, 20 * TARIFF.pricePerKwh);
    assert.equal(quote.total, 19000);
    assert.equal(quote.surgeApplied, false);
    assert.equal(quote.surgeMultiplier, 1);
    assert.equal(quote.fastChargeFee, 0);
  });

  test('con la flag de tarifa dinamica activa, en hora pico se aplica x1.5', () => {
    const quote = calculateQuote({ estimatedKwh: 20, surgePricingEnabled: true, hour: 18 });
    assert.equal(quote.surgeApplied, true);
    assert.equal(quote.total, 28500);
  });

  test('con la flag activa pero fuera de hora pico NO hay recargo', () => {
    const quote = calculateQuote({
      estimatedKwh: 20, surgePricingEnabled: true, hour: 3, peakHours: parsePeakHours('6-9,17-21'),
    });
    assert.equal(quote.surgeApplied, false);
    assert.equal(quote.total, 19000);
  });

  test('con la flag apagada nunca hay recargo, aunque sea hora pico', () => {
    const quote = calculateQuote({ estimatedKwh: 20, surgePricingEnabled: false, hour: 18 });
    assert.equal(quote.total, 19000);
  });

  test('la ultra-carga agrega 20 % sobre el valor de la energia', () => {
    assert.equal(calculateQuote({ estimatedKwh: 20, fastCharge: true }).fastChargeFee, 3800);
    // El recargo se calcula sobre el valor ya afectado por la tarifa dinamica.
    const both = calculateQuote({ estimatedKwh: 20, fastCharge: true, surgePricingEnabled: true, hour: 18 });
    assert.equal(both.fastChargeFee, 5700);
    assert.equal(both.total, 34200);
  });

  test('los valores son enteros (pesos, sin decimales)', () => {
    const quote = calculateQuote({ estimatedKwh: 13.37, fastCharge: true, surgePricingEnabled: true, hour: 18 });
    for (const field of ['baseAmount', 'fastChargeFee', 'total']) assert.ok(Number.isInteger(quote[field]), field);
  });

  test('rechaza energia no positiva o no numerica', () => {
    assert.throws(() => calculateQuote({ estimatedKwh: 0 }), RangeError);
    assert.throws(() => calculateQuote({ estimatedKwh: -5 }), RangeError);
    assert.throws(() => calculateQuote({ estimatedKwh: Number.NaN }), RangeError);
  });
});

describe('parsePeakHours', () => {
  test('por defecto todas las horas son pico (demostracion)', () => {
    assert.equal(parsePeakHours().size, 24);
  });

  test('interpreta rangos y horas sueltas', () => {
    const hours = parsePeakHours('6-9,17-21,23');
    assert.deepEqual([...hours], [6, 7, 8, 9, 17, 18, 19, 20, 21, 23]);
  });
});
