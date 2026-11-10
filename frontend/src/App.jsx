// =============================================================================
// Tablero de AegisVolt
//
// "Tiempo real" por sondeo (polling): cada 2,5 s se repite la consulta
// DASHBOARD_QUERY. Cualquier cambio (un conector reservado, una flag cambiada
// con AWS CLI, una SAGA compensada) aparece solo, sin recargar la pagina.
// =============================================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { DASHBOARD_QUERY, GRAPHQL_URL, gql } from './api.js';
import { StationsPanel } from './components/StationsPanel.jsx';
import { ReservePanel } from './components/ReservePanel.jsx';
import { FlagsPanel } from './components/FlagsPanel.jsx';
import { SagaHistory } from './components/SagaHistory.jsx';
import { SessionsPanel } from './components/SessionsPanel.jsx';
import { WalletsPanel } from './components/WalletsPanel.jsx';

const POLL_INTERVAL_MS = 2500;

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selection, setSelection] = useState(null); // { stationId, connectorId }
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await gql(DASHBOARD_QUERY));
      setError(null);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const env = data?.environment;
  const flags = Object.fromEntries((data?.featureFlags ?? []).map((f) => [f.name, f.enabled]));

  return (
    <div className={`app env-${env?.name ?? 'unknown'}`}>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">⚡</span>
          <div>
            <h1>AegisVolt</h1>
            <p>Gestion de carga para flotas electricas</p>
          </div>
        </div>
        <div className="env-info">
          <span className="env-badge" data-testid="env-badge">
            {env ? env.name.toUpperCase() : '…'}
          </span>
          <div className="env-meta">
            <span>gateway {env?.version ?? '—'}</span>
            <span className={error ? 'status-bad' : 'status-ok'}>
              {error ? 'sin conexion' : `actualizado ${lastUpdate?.toLocaleTimeString('es-CO', { hour12: false }) ?? '…'}`}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          No se pudo consultar el endpoint GraphQL (<code>{GRAPHQL_URL}</code>): {error}
        </div>
      )}

      {!data && !error && <p className="loading">Cargando tablero…</p>}

      {data && (
        <main className="grid">
          <StationsPanel stations={data.stations} selection={selection} onSelect={setSelection} />
          <ReservePanel
            stations={data.stations}
            wallets={data.wallets}
            flags={flags}
            selection={selection}
            onSelect={setSelection}
            onDone={refresh}
          />
          <FlagsPanel flags={data.featureFlags} environment={env.name} onChange={refresh} />
          <SessionsPanel sessions={data.chargingSessions} onChange={refresh} />
          <SagaHistory sagas={data.sagas} />
          <WalletsPanel wallets={data.wallets} onChange={refresh} />
        </main>
      )}

      {env && (
        <footer className="footer">
          <span>Endpoint GraphQL: <code>{GRAPHQL_URL}</code></span>
          <span className="services">
            {env.services.map((s) => (
              <span key={s.name} className={`svc ${s.status === 'ok' ? 'svc-ok' : 'svc-bad'}`} title={`track: ${s.track ?? '—'}`}>
                {s.name} <b>{s.version ?? s.status}</b>
              </span>
            ))}
          </span>
        </footer>
      )}
    </div>
  );
}
