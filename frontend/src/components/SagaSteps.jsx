// Resultado de una operacion "reservar y cargar", en dos niveles:
//  - OperationSteps: lo que entiende el operador (que paso y que se deshizo).
//  - TechnicalDetail: los pasos internos de la transaccion distribuida (SAGA),
//    sus compensaciones y el correlation_id para rastrear en CloudWatch. Oculto
//    por defecto; se usa para la sustentacion.
import { Icon } from '../icons.jsx';
import { FAILED_LABELS, PENDING_LABELS, STEP_LABELS, UNDO_LABELS } from '../labels.js';

export function OperationSteps({ operation }) {
  return (
    <ol className="steps">
      {operation.steps.map((step) => {
        const undo = step.compensation?.status === 'COMPENSATED' ? step.compensation : null;
        const undoFailed = step.compensation?.status === 'FAILED';
        const state = undo ? 'undone' : step.status.toLowerCase();
        return (
          <li key={step.name} className={`step step-${state}`}>
            <span className="step-mark" aria-hidden="true">
              {state === 'succeeded' && <Icon name="check" size={14} />}
              {state === 'undone' && <Icon name="undo" size={14} />}
              {state === 'failed' && <Icon name="x" size={14} />}
            </span>
            <span className="step-text">
              {undo && <span data-testid={`compensation-${undo.name}`}>{UNDO_LABELS[undo.name] ?? STEP_LABELS[step.name]}</span>}
              {!undo && state === 'succeeded' && <span>{STEP_LABELS[step.name] ?? step.name}</span>}
              {state === 'failed' && <span>{FAILED_LABELS[step.name] ?? step.name}</span>}
              {(state === 'pending' || state === 'running') && <span>{PENDING_LABELS[step.name] ?? step.name}</span>}
              {state === 'pending' && <span className="step-note">No se llegó a este paso</span>}
              {undoFailed && <span className="step-note step-note-bad">No se pudo deshacer</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TechnicalDetail({ operation }) {
  return (
    <details className="tech">
      <summary>
        <Icon name="code" size={14} />
        Ver detalle técnico
      </summary>
      <div className="tech-body">
        <dl className="tech-ids">
          <div>
            <dt>Estado de la SAGA</dt>
            <dd>
              <code>{operation.status}</code>
            </dd>
          </div>
          <div>
            <dt>correlation_id</dt>
            <dd>
              <code>{operation.correlationId}</code>
            </dd>
          </div>
          <div>
            <dt>saga_id</dt>
            <dd>
              <code>{operation.sagaId}</code>
            </dd>
          </div>
          {operation.failure && (
            <div>
              <dt>Fallo</dt>
              <dd>
                <code>
                  {operation.failure.step} · {operation.failure.code}
                </code>
              </dd>
            </div>
          )}
        </dl>
        <table className="tech-steps">
          <thead>
            <tr>
              <th scope="col">Paso</th>
              <th scope="col">Servicio</th>
              <th scope="col">Estado</th>
              <th scope="col">Compensación</th>
            </tr>
          </thead>
          <tbody>
            {operation.steps.map((step) => (
              <tr key={step.name}>
                <td>
                  <code>{step.name}</code>
                </td>
                <td>{step.service}</td>
                <td>
                  {step.status}
                  {step.attempts > 1 ? ` (${step.attempts} intentos)` : ''}
                </td>
                <td>
                  {step.compensation
                    ? `${step.compensation.name}: ${step.compensation.status}${
                        step.compensation.attempts > 1 ? ` (${step.compensation.attempts} intentos)` : ''
                      }`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
