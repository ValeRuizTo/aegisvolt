// Cargas en curso con su telemetria mas reciente.
import { useState } from 'react';
import { gql, STOP_MUTATION } from '../api.js';
import { Icon } from '../icons.jsx';

const number = (value, decimals = 1) =>
  value == null ? '—' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: decimals }).format(value);

export function SessionsPanel({ sessions, stationNames, fleetNames, onChange }) {
  const [stopping, setStopping] = useState(null);
  const [error, setError] = useState(null);

  async function stop(sagaId) {
    setStopping(sagaId);
    setError(null);
    try {
      await gql(STOP_MUTATION, { sagaId });
      await onChange();
    } catch {
      setError('No se pudo detener la carga. Inténtalo de nuevo.');
    } finally {
      setStopping(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="sessions-title">
      <header className="panel-head">
        <h2 id="sessions-title">
          <Icon name="battery" />
          Cargas en curso
        </h2>
        {sessions.length > 0 && <span className="panel-meta">{sessions.length} activas</span>}
      </header>

      {sessions.length === 0 ? (
        <p className="empty">Ningún vehículo está cargando ahora. Cuando inicies una carga, verás aquí su avance.</p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => {
            const t = session.latestTelemetry;
            const progress = t?.progressPercent ?? 0;
            const done = t?.finished === true;
            return (
              <li key={session.sagaId} className={`session${done ? ' is-done' : ''}`} data-testid="active-session">
                <div className="session-head">
                  <div>
                    <p className="session-place">
                      {stationNames[session.stationId] ?? session.stationId} · {session.connectorId}
                    </p>
                    <p className="session-fleet">{fleetNames[session.fleetId] ?? session.fleetId}</p>
                  </div>
                  <span className="session-pct">{done ? 'Completa' : `${Math.round(progress)} %`}</span>
                </div>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={Math.round(progress)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Avance de la carga"
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <dl className="telemetry">
                  <div>
                    <dt>Energía</dt>
                    <dd>
                      {number(t?.kwhDelivered)} / {number(session.targetKwh, 0)} kWh
                    </dd>
                  </div>
                  <div>
                    <dt>Potencia</dt>
                    <dd>{number(t?.powerKw)} kW</dd>
                  </div>
                  <div>
                    <dt>Voltaje</dt>
                    <dd>{number(t?.voltage, 0)} V</dd>
                  </div>
                  <div>
                    <dt>Temperatura</dt>
                    <dd>{number(t?.connectorTempC)} °C</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={stopping === session.sagaId}
                  onClick={() => stop(session.sagaId)}
                  data-testid="stop-button"
                >
                  <Icon name="stop" size={16} />
                  {stopping === session.sagaId ? 'Deteniendo…' : done ? 'Terminar y liberar conector' : 'Detener carga'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="callout callout-bad" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
