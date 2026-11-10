// Panel (b): flujo de reserva y activacion de carga = disparador de la SAGA.
import { useEffect, useMemo, useState } from 'react';
import { gql, money, QUOTE_QUERY, RESERVE_MUTATION } from '../api.js';
import { SagaSteps } from './SagaSteps.jsx';

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

  // Si la flag se apaga mientras la casilla estaba marcada, se desmarca.
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
          label: `${s.name} · ${c.connectorId} (${c.powerKw} kW)`,
          available: c.status === 'AVAILABLE',
          ultraFast: c.ultraFast,
        })),
      ),
    [stations],
  );
  const selected = options.find((o) => o.stationId === selection?.stationId && o.connectorId === selection?.connectorId);
  const wallet = wallets.find((w) => w.fleetId === fleetId);

  // Cotizacion en vivo: cambia sola cuando se activa la tarifa dinamica.
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
          // Clave de idempotencia: un doble clic no crea dos SAGAs.
          clientRequestId: crypto.randomUUID(),
        },
      });
      setResult(data.reserveAndCharge);
      onSelect(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
      onDone();
    }
  }

  return (
    <section className="panel panel-reserve" aria-labelledby="reserve-title">
      <div className="panel-head">
        <h2 id="reserve-title">Reservar y activar carga</h2>
        <span className="hint">dispara la SAGA</span>
      </div>

      <form onSubmit={submit} className="form">
        <label>
          Flota
          <select value={fleetId} onChange={(e) => setFleetId(e.target.value)} data-testid="fleet-select">
            {wallets.map((w) => (
              <option key={w.fleetId} value={w.fleetId}>
                {w.fleetName} — {money(w.balance, w.currency)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Conector
          <select
            value={selected?.key ?? ''}
            onChange={(e) => {
              const option = options.find((o) => o.key === e.target.value);
              onSelect(option ? { stationId: option.stationId, connectorId: option.connectorId } : null);
            }}
            data-testid="connector-select"
          >
            <option value="">Seleccione un conector disponible…</option>
            {options.map((o) => (
              <option key={o.key} value={o.key} disabled={!o.available}>
                {o.label}
                {o.available ? '' : ' — ocupado'}
              </option>
            ))}
          </select>
        </label>

        <label>
          Energia estimada (kWh)
          <input
            type="number"
            min="1"
            max="500"
            step="1"
            value={estimatedKwh}
            onChange={(e) => setEstimatedKwh(e.target.value)}
            data-testid="kwh-input"
          />
        </label>

        {fastChargeEnabled ? (
          <label className="check" data-testid="fast-charge-option">
            <input
              type="checkbox"
              checked={fastCharge}
              disabled={selected ? !selected.ultraFast : false}
              onChange={(e) => setFastCharge(e.target.checked)}
            />
            <span>
              Ultra-carga prioritaria (+20 %)
              {selected && !selected.ultraFast && <small> · requiere un conector de 150 kW o mas</small>}
            </span>
          </label>
        ) : (
          <p className="flag-note" data-testid="fast-charge-disabled">
            Ultra-carga no disponible en este ambiente (flag <code>ENABLE_FAST_CHARGE_BOOST</code> apagada).
          </p>
        )}

        {quote && (
          <dl className="quote" data-testid="quote">
            <div>
              <dt>Tarifa base</dt>
              <dd>{money(quote.baseAmount)}</dd>
            </div>
            <div className={quote.surgeApplied ? 'quote-surge' : ''}>
              <dt>Tarifa dinamica</dt>
              <dd data-testid="quote-surge">{quote.surgeApplied ? `× ${quote.surgeMultiplier} (hora pico)` : 'no aplica'}</dd>
            </div>
            {quote.fastChargeFee > 0 && (
              <div>
                <dt>Ultra-carga</dt>
                <dd>{money(quote.fastChargeFee)}</dd>
              </div>
            )}
            <div className="quote-total">
              <dt>Total a retener</dt>
              <dd data-testid="quote-total">{money(quote.total)}</dd>
            </div>
          </dl>
        )}

        {wallet && quote && quote.total > wallet.balance && (
          <p className="warn">El saldo de la flota no alcanza: la SAGA fallara en el cobro y liberara el conector.</p>
        )}
        {faultEnabled && (
          <p className="warn" data-testid="fault-warning">
            Inyeccion de fallos ACTIVA en este ambiente: el cargador reportara averia y la SAGA hara rollback.
          </p>
        )}

        <button type="submit" className="primary" disabled={submitting || !selected || !fleetId} data-testid="reserve-button">
          {submitting ? 'Ejecutando SAGA…' : 'Reservar y activar carga'}
        </button>
      </form>

      {error && (
        <div className="banner banner-error" role="alert" data-testid="reserve-error">
          {error}
        </div>
      )}

      {result && (
        <div className={`result result-${result.status.toLowerCase()}`} data-testid="saga-result">
          <p className="result-title">
            {result.status === 'COMPLETED' && 'Carga activada'}
            {result.status === 'COMPENSATED' && 'Operacion revertida (rollback distribuido)'}
            {result.status === 'COMPENSATION_FAILED' && 'Rollback incompleto: requiere atencion'}
          </p>
          {result.failure && (
            <p className="result-reason">
              Fallo en <b>{result.failure.step}</b>: {result.failure.message}
            </p>
          )}
          <SagaSteps saga={result} />
          <p className="correlation">
            correlation_id <code>{result.correlationId}</code>
          </p>
        </div>
      )}
    </section>
  );
}
