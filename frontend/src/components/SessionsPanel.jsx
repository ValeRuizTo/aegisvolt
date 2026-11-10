// Sesiones de carga activas con su telemetria mas reciente.
import { useState } from 'react';
import { gql, STOP_MUTATION } from '../api.js';

export function SessionsPanel({ sessions, onChange }) {
  const [stopping, setStopping] = useState(null);
  const [error, setError] = useState(null);

  async function stop(sagaId) {
    setStopping(sagaId);
    setError(null);
    try {
      await gql(STOP_MUTATION, { sagaId });
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setStopping(null);
    }
  }

  return (
    <section className="panel panel-sessions" aria-labelledby="sessions-title">
      <div className="panel-head">
        <h2 id="sessions-title">Cargas en curso</h2>
        <span className="count">{sessions.length} activas</span>
      </div>

      {sessions.length === 0 ? (
        <p className="empty">No hay sesiones de carga activas.</p>
      ) : (
        <ul className="sessions">
          {sessions.map((session) => {
            const t = session.latestTelemetry;
            const progress = t?.progressPercent ?? 0;
            return (
              <li key={session.sagaId} className="session" data-testid="active-session">
                <div className="session-head">
                  <strong>
                    {session.stationId} / {session.connectorId}
                  </strong>
                  <span>{session.fleetId}</span>
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
                    <dt>Energia</dt>
                    <dd>
                      {t?.kwhDelivered ?? 0} / {session.targetKwh} kWh
                    </dd>
                  </div>
                  <div>
                    <dt>Potencia</dt>
                    <dd>{t?.powerKw ?? '—'} kW</dd>
                  </div>
                  <div>
                    <dt>Tension</dt>
                    <dd>{t?.voltage ?? '—'} V</dd>
                  </div>
                  <div>
                    <dt>Temp.</dt>
                    <dd>{t?.connectorTempC ?? '—'} °C</dd>
                  </div>
                </dl>
                <button
                  type="button"
                  className="secondary"
                  disabled={stopping === session.sagaId}
                  onClick={() => stop(session.sagaId)}
                  data-testid="stop-button"
                >
                  {stopping === session.sagaId ? 'Deteniendo…' : t?.finished ? 'Finalizar y liberar' : 'Detener carga'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
