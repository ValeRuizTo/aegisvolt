// Historial de cargas: cada intento de reservar y cargar, con lo que paso.
import { Fragment, useState } from 'react';
import { money, time } from '../api.js';
import { Icon } from '../icons.jsx';
import { failureReason, OPERATION_STATUS, undoSummary } from '../labels.js';
import { OperationSteps, TechnicalDetail } from './SagaSteps.jsx';

function outcome(operation) {
  if (operation.status === 'COMPLETED') return 'La carga se inició correctamente.';
  if (operation.status === 'STARTED') return 'Esperando respuesta del cargador.';
  if (operation.status === 'COMPENSATION_FAILED') return 'No se pudo deshacer todo automáticamente.';
  return `${failureReason(operation.failure?.code)} ${undoSummary(operation)}`;
}

export function SagaHistory({ sagas, stationNames, fleetNames }) {
  const [open, setOpen] = useState(null);

  return (
    <section className="panel" aria-labelledby="history-title">
      <header className="panel-head">
        <h2 id="history-title">
          <Icon name="history" />
          Historial de cargas
        </h2>
        {sagas.length > 0 && <span className="panel-meta">Últimas {sagas.length}</span>}
      </header>

      {sagas.length === 0 ? (
        <p className="empty">Todavía no hay cargas registradas. La primera que inicies aparecerá aquí.</p>
      ) : (
        <div className="table-wrap">
          <table className="history" data-testid="saga-history">
            <thead>
              <tr>
                <th scope="col">Hora</th>
                <th scope="col">Resultado</th>
                <th scope="col">Carga</th>
                <th scope="col" className="num">
                  Valor
                </th>
                <th scope="col">Qué pasó</th>
                <th scope="col">
                  <span className="sr-only">Más información</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sagas.map((operation) => {
                const status = OPERATION_STATUS[operation.status] ?? { label: operation.status, tone: 'info' };
                const expanded = open === operation.sagaId;
                const charged = operation.status === 'COMPLETED' && operation.amount != null;
                return (
                  <Fragment key={operation.sagaId}>
                    <tr data-testid={`saga-row-${operation.status}`}>
                      <td className="nowrap">{time(operation.createdAt)}</td>
                      <td>
                        <span className={`pill pill-${status.tone}`}>{status.label}</span>
                      </td>
                      <td>
                        <span className="cell-main">{fleetNames[operation.fleetId] ?? operation.fleetId}</span>
                        <span className="cell-sub">
                          {stationNames[operation.stationId] ?? operation.stationId} · {operation.connectorId}
                        </span>
                      </td>
                      <td className="num">{charged ? money(operation.amount) : <span className="muted">Sin cobro</span>}</td>
                      <td className="outcome">{outcome(operation)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-expanded={expanded}
                          onClick={() => setOpen(expanded ? null : operation.sagaId)}
                        >
                          {expanded ? 'Ocultar' : 'Ver pasos'}
                          <Icon name="chevron" size={14} className={expanded ? 'is-flipped' : ''} />
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="row-detail">
                        <td colSpan={6}>
                          <OperationSteps operation={operation} />
                          <TechnicalDetail operation={operation} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
