// Nueva carga: reservar un conector, retener el saldo y encender el cargador.
// (Por dentro dispara la operacion distribuida reserveAndCharge.)
import { useEffect, useMemo, useState } from 'react';
import { gql, money, QUOTE_QUERY, RESERVE_MUTATION } from '../api.js';
import { Icon } from '../icons.jsx';
import { failureReason, undoSummary } from '../labels.js';
import { OperationSteps, TechnicalDetail } from './SagaSteps.jsx';

export function ReservePanel({ stations, wallets, flags, selection, onSelect, onDone }) {
  const [fleetId, setFleetId] = useState('');
  const [estimatedKwh, setEstimatedKwh] = useState(30);
  const [fastCharge, setFastCharge] = useState(false);
  const [quote, setQuote] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const fastChargeEnabled = flags.ENABLE_FAST_CHARGE_BOOST === true;
  const surgeEnabled = flags.ENABLE_DYNAMIC_SURGE_PRICING === true;
  const faultEnabled = flags.SIMULATE_CHARGER_HARDWARE_FAULT === true;

  useEffect(() => {
    if (!fleetId && wallets.length > 0) setFleetId(wallets[0].fleetId);
  }, [wallets, fleetId]);

  useEffect(() => {
    if (!fastChargeEnabled) setFastCharge(false);
  }, [fastChargeEnabled]);

  const options = useMemo(
    () =>
      stations.flatMap((s) =>
        s.connectors.map((c) => ({
          key: `${s.stationId}|${c.connectorId}`,
          stationId: s.stationId,
          connectorId: c.connectorId,
          stationName: s.name,
          label: `${s.name} · ${c.connectorId} · ${c.powerKw} kW`,
          available: c.status === 'AVAILABLE',
          ultraFast: c.ultraFast,
        })),
      ),
    [stations],
  );
  const selected = options.find((o) => o.stationId === selection?.stationId && o.connectorId === selection?.connectorId);
  const wallet = wallets.find((w) => w.fleetId === fleetId);

  useEffect(() => {
    if (selected && !selected.ultraFast) setFastCharge(false);
  }, [selected]);

  // Precio estimado en vivo: cambia solo si se activa la tarifa de hora pico.
  useEffect(() => {
    const kwh = Number(estimatedKwh);
    if (!(kwh > 0)) {
      setQuote(null);
      return undefined;
    }
    let cancelled = false;
    gql(QUOTE_QUERY, { estimatedKwh: kwh, fastCharge: fastCharge && fastChargeEnabled })
      .then((data) => !cancelled && setQuote(data.quote))
      .catch(() => !cancelled && setQuote(null));
    return () => {
      cancelled = true;
    };
  }, [estimatedKwh, fastCharge, fastChargeEnabled, surgeEnabled]);

  async function submit(event) {
    event.preventDefault();
    if (!selected || !fleetId) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const data = await gql(RESERVE_MUTATION, {
        input: {
          fleetId,
          stationId: selected.stationId,
          connectorId: selected.connectorId,
          estimatedKwh: Number(estimatedKwh),
          fastCharge: fastCharge && fastChargeEnabled,
          // Evita que un doble clic cree dos cargas.
          clientRequestId: crypto.randomUUID(),
        },
      });
      setResult({ operation: data.reserveAndCharge, place: `${selected.stationName} · conector ${selected.connectorId}` });
      onSelect(null);
    } catch (err) {
      setError(err.code === 'FAST_CHARGE_DISABLED' ? failureReason(err.code) : 'No pudimos registrar la carga. Inténtalo de nuevo en unos segundos.');
    } finally {
      setSubmitting(false);
      onDone();
    }
  }

  const notEnoughBalance = wallet && quote && quote.total > wallet.balance;

  return (
    <section className="panel panel-primary" aria-labelledby="reserve-title">
      <header className="panel-head">
        <h2 id="reserve-title">
          <Icon name="bolt" />
          Nueva carga
        </h2>
      </header>

      <form onSubmit={submit} className="form">
        <label className="field">
          <span className="field-label">Flota</span>
          <select value={fleetId} onChange={(e) => setFleetId(e.target.value)} data-testid="fleet-select">
            {wallets.map((w) => (
              <option key={w.fleetId} value={w.fleetId}>
                {w.fleetName} · saldo {money(w.balance, w.currency)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Conector</span>
          <select
            value={selected?.key ?? ''}
            onChange={(e) => {
              const option = options.find((o) => o.key === e.target.value);
              onSelect(option ? { stationId: option.stationId, connectorId: option.connectorId } : null);
            }}
            data-testid="connector-select"
          >
            <option value="">Elige un conector libre</option>
            {options.map((o) => (
              <option key={o.key} value={o.key} disabled={!o.available}>
                {o.label}
                {o.available ? '' : ' (ocupado)'}
              </option>
            ))}
          </select>
          <span className="field-help">También puedes tocar un conector libre en la lista de electrolineras.</span>
        </label>

        <label className="field">
          <span className="field-label">Energía a cargar</span>
          <span className="input-unit">
            <input
              type="number"
              min="1"
              max="500"
              step="1"
              inputMode="numeric"
              value={estimatedKwh}
              onChange={(e) => setEstimatedKwh(e.target.value)}
              data-testid="kwh-input"
            />
            <span aria-hidden="true">kWh</span>
          </span>
        </label>

        {fastChargeEnabled ? (
          <label className={`check${selected && !selected.ultraFast ? ' is-disabled' : ''}`} data-testid="fast-charge-option">
            <input
              type="checkbox"
              checked={fastCharge}
              disabled={selected ? !selected.ultraFast : false}
              onChange={(e) => setFastCharge(e.target.checked)}
            />
            <span>
              <span className="check-title">Carga prioritaria (+20 %)</span>
              <span className="check-help">
                {selected && !selected.ultraFast
                  ? 'Este conector no la admite: elige uno de 150 kW o más.'
                  : 'Solo en conectores rápidos de 150 kW o más.'}
              </span>
            </span>
          </label>
        ) : (
          <p className="note" data-testid="fast-charge-disabled">
            La carga prioritaria no está disponible en este ambiente.
          </p>
        )}

        {quote && (
          <div className="quote" data-testid="quote">
            <div className="quote-row">
              <span>
                Energía ({quote.estimatedKwh ?? Number(estimatedKwh)} kWh × {money(quote.pricePerKwh)})
              </span>
              <span>{money(quote.baseAmount)}</span>
            </div>
            <div className={`quote-row${quote.surgeApplied ? ' is-surge' : ''}`}>
              <span>Tarifa de hora pico</span>
              <span data-testid="quote-surge">{quote.surgeApplied ? `× ${String(quote.surgeMultiplier).replace('.', ',')}` : 'No aplica'}</span>
            </div>
            {quote.fastChargeFee > 0 && (
              <div className="quote-row">
                <span>Carga prioritaria</span>
                <span>{money(quote.fastChargeFee)}</span>
              </div>
            )}
            <div className="quote-total">
              <span>Se retiene de la billetera</span>
              <span data-testid="quote-total">{money(quote.total)}</span>
            </div>
          </div>
        )}

        {notEnoughBalance && (
          <p className="callout callout-warn">
            <Icon name="alert" />
            <span>Esta flota no tiene saldo suficiente. Si continúas, la carga se cancelará sin cobrar nada.</span>
          </p>
        )}
        {faultEnabled && (
          <p className="callout callout-warn" data-testid="fault-warning">
            <Icon name="alert" />
            <span>
              <strong>Simulación de averías activa.</strong> Los cargadores fallarán al encender y la carga se cancelará
              sola.
            </span>
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={submitting || !selected || !fleetId} data-testid="reserve-button">
          <Icon name="bolt" />
          {submitting ? 'Iniciando carga…' : 'Reservar y empezar a cargar'}
        </button>
      </form>

      {error && (
        <p className="callout callout-bad" role="alert" data-testid="reserve-error">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      {result && <OperationResult {...result} />}
    </section>
  );
}

function OperationResult({ operation, place }) {
  const ok = operation.status === 'COMPLETED';
  const partial = operation.status === 'COMPENSATION_FAILED';
  return (
    <div
      className={`result ${ok ? 'result-ok' : partial ? 'result-bad' : 'result-warn'}`}
      role="status"
      data-testid="saga-result"
    >
      <div className="result-head">
        <span className="result-icon" aria-hidden="true">
          <Icon name={ok ? 'check' : 'undo'} size={18} />
        </span>
        <div>
          <p className="result-title">{ok ? 'Carga iniciada' : 'No se pudo iniciar la carga'}</p>
          <p className="result-text">
            {ok && (
              <>
                {place}. Se retuvieron <strong>{money(operation.amount)}</strong> de la billetera.
              </>
            )}
            {!ok && !partial && (
              <>
                {failureReason(operation.failure?.code)} {undoSummary(operation)}
              </>
            )}
            {partial && 'No se pudo deshacer todo automáticamente. Revisa el historial antes de volver a intentarlo.'}
          </p>
        </div>
      </div>
      <OperationSteps operation={operation} />
      <TechnicalDetail operation={operation} />
    </div>
  );
}
