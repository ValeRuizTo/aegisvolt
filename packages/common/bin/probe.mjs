#!/usr/bin/env node
// =============================================================================
// Sonda HTTP para el analisis del CANARY
//
// Envia N peticiones a una URL y resume: cuantas respondieron bien, cuantas
// fallaron (5xx o sin respuesta) y que "track" (stable/canary) atendio cada una
// segun la cabecera x-served-by-track.
//
// Viaja dentro de la imagen de cada servicio; el pipeline la ejecuta con
// "kubectl exec" para medir desde DENTRO del cluster.
//
//   node probe.mjs --url http://billing-wallet-service:3000/wallets --count 50
//   node probe.mjs --url http://gateway:3000/graphql --method POST --body '{"query":"{__typename}"}'
//
// Salida: una linea JSON
//   {"total":50,"ok":50,"errors":0,"successRate":100,"byTrack":{"stable":41,"canary":9},"byVersion":{...}}
// =============================================================================

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);

const url = args.url;
const count = Number(args.count ?? 30);
const method = args.method ?? 'GET';
const body = args.body;
const delayMs = Number(args.delay ?? 50);

if (!url) {
  console.error('uso: probe.mjs --url <url> [--count N] [--method POST --body JSON] [--delay ms]');
  process.exit(2);
}

const summary = { url, total: 0, ok: 0, errors: 0, successRate: 0, byTrack: {}, byVersion: {}, statuses: {} };

for (let i = 0; i < count; i += 1) {
  summary.total += 1;
  try {
    const response = await fetch(url, {
      method,
      // "connection: close" => cada peticion abre una conexion nueva, de modo
      // que el Service de Kubernetes vuelve a elegir pod en cada una.
      headers: { connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      signal: AbortSignal.timeout(4000),
    });
    await response.arrayBuffer();
    const track = response.headers.get('x-served-by-track') ?? 'unknown';
    const version = response.headers.get('x-served-by-version') ?? 'unknown';
    summary.byTrack[track] = (summary.byTrack[track] ?? 0) + 1;
    summary.byVersion[version] = (summary.byVersion[version] ?? 0) + 1;
    summary.statuses[response.status] = (summary.statuses[response.status] ?? 0) + 1;
    if (response.status >= 500) summary.errors += 1;
    else summary.ok += 1;
  } catch {
    summary.errors += 1;
    summary.statuses.no_response = (summary.statuses.no_response ?? 0) + 1;
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

summary.successRate = Math.round((summary.ok / summary.total) * 1000) / 10;
console.log(JSON.stringify(summary));
