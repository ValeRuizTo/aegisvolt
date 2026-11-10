// Panel (d): historial de transacciones distribuidas y estado de compensaciones.
import { useState } from 'react';
import { money, time } from '../api.js';
import { SagaSteps } from './SagaSteps.jsx';

const STATUS_LABEL = {
  STARTED: 'En curso',
  COMPLETED: 'Completada',
  COMPENSATING: 'Compensando',
  COMPENSATED: 'Compensada',
  COMPENSATION_FAILED: 'Compensacion fallida',
};

export function SagaHistory({ sagas }) {
  const [open, setOpen] = useState(null);

  return (
    <section className="panel panel-history" aria-labelledby="history-title">
      <div className="panel-head">
        <h2 id="history-title">Historial de transacciones (SAGA)</h2>
        <span className="count">{sagas.length} mas recientes</span>
      </div>

      {sagas.length === 0 ? (
        <p className="empty">Aun no hay transacciones. Reserve un conector para iniciar la primera SAGA.</p>
      ) : (
        <div className="table-wrap">
          <table className="history" data-testid="saga-history">
            <thead>
              <tr>
                <th scope="col">Hora</th>
                <th scope="col">Estado</th>
                <th scope="col">Flota</th>
                <th scope="col">Conector</th>
                <th scope="col" className="num">Valor</th>
                <th scope="col">Compensaciones</th>
                <th scope="col">
                  <span className="sr-only">Detalle</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sagas.map((saga) => {
                const compensations = saga.steps.filter((s) => s.compensation?.status === 'COMPENSATED');
                const expanded = open === saga.sagaId;
                return (
                  <FragmentRow
                    key={saga.sagaId}
                    saga={saga}
                    compensations={compensations}
                    expanded={expanded}
                    onToggle={() => setOpen(expanded ? null : saga.sagaId)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FragmentRow({ saga, compensations, expanded, onToggle }) {
  return (
    <>
      <tr className={`row-${saga.status.toLowerCase()}`} data-testid={`saga-row-${saga.status}`}>
        <td>{time(saga.createdAt)}</td>
        <td>
          <span className={`pill pill-${saga.status.toLowerCase()}`}>{STATUS_LABEL[saga.status] ?? saga.status}</span>
        </td>
        <td>{saga.fleetId}</td>
        <td>
          {saga.stationId} / {saga.connectorId}
        </td>
        <td className="num">{saga.amount != null ? money(saga.amount) : '—'}</td>
        <td>
          {compensations.length > 0
            ? compensations.map((s) => s.compensation.name).join(' → ')
            : saga.failure
              ? 'sin efectos que revertir'
              : '—'}
        </td>
        <td>
          <button type="button" className="link" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? 'Ocultar' : 'Detalle'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={7}>
            {saga.failure && (
              <p className="result-reason">
                Fallo en <b>{saga.failure.step}</b> ({saga.failure.code}): {saga.failure.message}
              </p>
            )}
            <SagaSteps saga={saga} />
            <p className="correlation">
              saga_id <code>{saga.sagaId}</code> · correlation_id <code>{saga.correlationId}</code>
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
