// PRUEBAS UNITARIAS - simulacion de telemetria (logica pura)
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSample, sampleIndexAt, SAMPLE_INTERVAL_SECONDS } from '../src/telemetry.js';

const session = { startedAt: '2026-01-01T10:00:00.000Z', powerKw: 150, targetKwh: 40 };

describe('sampleIndexAt', () => {
  test('la muestra 0 corresponde al instante de inicio', () => {
    assert.equal(sampleIndexAt(session.startedAt, new Date(session.startedAt)), 0);
  });

  test('avanza una muestra por cada intervalo', () => {
    const at = (seconds) => new Date(new Date(session.startedAt).getTime() + seconds * 1000);
    assert.equal(sampleIndexAt(session.startedAt, at(SAMPLE_INTERVAL_SECONDS - 1)), 0);
    assert.equal(sampleIndexAt(session.startedAt, at(SAMPLE_INTERVAL_SECONDS)), 1);
    assert.equal(sampleIndexAt(session.startedAt, at(SAMPLE_INTERVAL_SECONDS * 7 + 2)), 7);
  });

  test('nunca es negativo (relojes desincronizados)', () => {
    assert.equal(sampleIndexAt(session.startedAt, new Date('2025-12-31T00:00:00Z')), 0);
  });
});

describe('buildSample', () => {
  test('es determinista: la misma muestra produce exactamente los mismos valores', () => {
    assert.deepEqual(buildSample(session, 5), buildSample(session, 5));
  });

  test('la energia entregada crece con el tiempo', () => {
    const energies = [0, 1, 2, 3].map((i) => buildSample(session, i).kwhDelivered);
    assert.equal(energies[0], 0);
    for (let i = 1; i < energies.length; i += 1) assert.ok(energies[i] > energies[i - 1]);
  });

  test('nunca entrega mas energia que la solicitada y al llegar corta la potencia', () => {
    const last = buildSample(session, 10000);
    assert.equal(last.kwhDelivered, session.targetKwh);
    assert.equal(last.progressPercent, 100);
    assert.equal(last.finished, true);
    assert.equal(last.powerKw, 0);
    assert.equal(last.currentAmps, 0);
  });

  test('la potencia se mantiene cerca de la nominal del conector', () => {
    const sample = buildSample(session, 2);
    assert.ok(sample.powerKw > session.powerKw * 0.9 && sample.powerKw <= session.powerKw);
    assert.ok(sample.voltage > 380 && sample.voltage < 420);
  });
});
