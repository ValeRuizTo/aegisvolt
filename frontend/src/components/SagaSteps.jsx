// Linea de pasos de una SAGA, con el estado de cada compensacion.
const STEP_LABEL = {
  RESERVE_CONNECTOR: 'Reservar conector',
  CHARGE_WALLET: 'Cobrar a la billetera',
  START_CHARGING: 'Activar cargador',
  CONFIRM_RESERVATION: 'Confirmar reserva',
};

const COMPENSATION_LABEL = {
  RELEASE_CONNECTOR: 'conector liberado',
  REFUND_WALLET: 'saldo reembolsado',
  STOP_CHARGING: 'carga detenida',
};

const STEP_MARK = { SUCCEEDED: '✓', FAILED: '✕', RUNNING: '…', PENDING: '·' };

export function SagaSteps({ saga }) {
  return (
    <ol className="steps">
      {saga.steps.map((step, index) => {
        const compensation = step.compensation;
        const compensated = compensation?.status === 'COMPENSATED';
        const compensationFailed = compensation?.status === 'FAILED';
        return (
          <li key={step.name} className={`step step-${step.status.toLowerCase()}`}>
            <span className="step-mark" aria-hidden="true">
              {STEP_MARK[step.status]}
            </span>
            <div className="step-body">
              <span className="step-name">
                {index + 1}. {STEP_LABEL[step.name] ?? step.name}
              </span>
              <span className="step-service">{step.service}</span>
              {step.status === 'FAILED' && step.error && <span className="step-error">{step.error}</span>}
              {compensated && (
                <span className="step-compensation" data-testid={`compensation-${compensation.name}`}>
                  ↩ compensado: {COMPENSATION_LABEL[compensation.name] ?? compensation.name}
                  {compensation.attempts > 1 ? ` (${compensation.attempts} intentos)` : ''}
                </span>
              )}
              {compensationFailed && (
                <span className="step-compensation step-compensation-failed">
                  ↩ compensacion fallida: {compensation.error}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
