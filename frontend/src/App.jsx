// =============================================================================
// Tablero de AegisVolt
//
// "Tiempo real" por sondeo: cada 2,5 s se repite la consulta DASHBOARD_QUERY.
// Cualquier cambio (un conector reservado, un ajuste cambiado por AWS CLI, una
// carga cancelada) aparece solo, sin recargar la pagina.
//
// Distribucion: a la izquierda lo que se vigila (electrolineras, cargas,
// historial); a la derecha lo que se hace (nueva carga, billeteras, ajustes).
// =============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DASHBOARD_QUERY, GRAPHQL_URL, gql } from './api.js';
import { Icon } from './icons.jsx';
import { ENV_NAMES } from './labels.js';
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
  const envKey = env?.name ?? 'unknown';
  const flags = Object.fromEntries((data?.featureFlags ?? []).map((f) => [f.name, f.enabled]));
  const stationNames = useMemo(
    () => Object.fromEntries((data?.stations ?? []).map((s) => [s.stationId, s.name])),
    [data?.stations],
  );
  const fleetNames = useMemo(
    () => Object.fromEntries((data?.wallets ?? []).map((w) => [w.fleetId, w.fleetName])),
    [data?.wallets],
  );

  useEffect(() => {
    document.title = env ? `AegisVolt · ${ENV_NAMES[env.name] ?? env.name}` : 'AegisVolt';
  }, [env]);

  return (
    <div className={`app env-${envKey}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Icon name="bolt" size={20} />
            </span>
            <div>
              <p className="brand-name">AegisVolt</p>
              <p className="brand-tag">Carga para flotas eléctricas</p>
            </div>
          </div>
          <div className="env">
            <span className="env-chip">
              <span className="env-code" data-testid="env-badge">
                {env ? env.name.toUpperCase() : '…'}
              </span>
              <span className="env-name">{env ? `Ambiente de ${(ENV_NAMES[env.name] ?? env.name).toLowerCase()}` : 'Conectando…'}</span>
            </span>
            <span className={`live${error ? ' is-off' : ''}`}>
              <span className="live-dot" aria-hidden="true" />
              {error
                ? 'Sin conexión'
                : lastUpdate
                  ? `Actualizado ${lastUpdate.toLocaleTimeString('es-CO', { hour12: false })}`
                  : 'Conectando…'}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <Icon name="alert" />
          <span>No pudimos conectarnos con el servidor. Seguimos intentando automáticamente.</span>
        </div>
      )}

      {!data && !error && (
        <div className="loading" aria-busy="true">
          <div className="skeleton skeleton-wide" />
          <div className="skeleton skeleton-side" />
        </div>
      )}

      {data && (
        <main className="layout">
          <div className="col col-main">
            <div className="slot slot-stations">
              <StationsPanel stations={data.stations} selection={selection} onSelect={setSelection} />
            </div>
            <div className="slot slot-sessions">
              <SessionsPanel
                sessions={data.chargingSessions}
                stationNames={stationNames}
                fleetNames={fleetNames}
                onChange={refresh}
              />
            </div>
            <div className="slot slot-history">
              <SagaHistory sagas={data.sagas} stationNames={stationNames} fleetNames={fleetNames} />
            </div>
          </div>
          <div className="col col-side">
            <div className="slot slot-reserve">
              <ReservePanel
                stations={data.stations}
                wallets={data.wallets}
                flags={flags}
                selection={selection}
                onSelect={setSelection}
                onDone={refresh}
              />
            </div>
            <div className="slot slot-wallets">
              <WalletsPanel wallets={data.wallets} onChange={refresh} />
            </div>
            <div className="slot slot-flags">
              <FlagsPanel flags={data.featureFlags} environment={env.name} onChange={refresh} />
            </div>
          </div>
        </main>
      )}

      {env && (
        <footer className="footer">
          <details className="tech">
            <summary>
              <Icon name="code" size={14} />
              Detalle técnico del ambiente
            </summary>
            <div className="tech-body">
              <dl className="tech-ids">
                <div>
                  <dt>Endpoint GraphQL</dt>
                  <dd>
                    <code>{GRAPHQL_URL}</code>
                  </dd>
                </div>
                {data.featureFlags.map((f) => (
                  <div key={f.name}>
                    <dt>Feature flag</dt>
                    <dd>
                      <code>
                        {f.name} = {String(f.enabled)}
                      </code>
                    </dd>
                  </div>
                ))}
                {env.services.map((s) => (
                  <div key={s.name}>
                    <dt>{s.name}</dt>
                    <dd>
                      <code>
                        {s.status === 'ok' ? s.version : s.status}
                        {s.track ? ` · ${s.track}` : ''}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
        </footer>
      )}
    </div>
  );
}
