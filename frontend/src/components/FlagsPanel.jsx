// Panel (c): Feature Flags activas en el ambiente actual.
import { useState } from 'react';
import { gql, SET_FLAG_MUTATION, time } from '../api.js';

const FLAG_TITLE = {
  ENABLE_DYNAMIC_SURGE_PRICING: 'Tarifa dinamica en hora pico',
  ENABLE_FAST_CHARGE_BOOST: 'Ultra-carga prioritaria',
  SIMULATE_CHARGER_HARDWARE_FAULT: 'Simular averia del cargador',
};

export function FlagsPanel({ flags, environment, onChange }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);

  async function toggle(flag) {
    setPending(flag.name);
    setError(null);
    try {
      await gql(SET_FLAG_MUTATION, { name: flag.name, enabled: !flag.enabled });
      await onChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel panel-flags" aria-labelledby="flags-title">
      <div className="panel-head">
        <h2 id="flags-title">Feature Flags</h2>
        <span className="hint">
          tabla <code>aegisvolt-feature-flags-{environment}</code>
        </span>
      </div>

      <ul className="flags">
        {flags.map((flag) => (
          <li key={flag.name} className={`flag ${flag.enabled ? 'flag-on' : 'flag-off'}`} data-testid={`flag-${flag.name}`}>
            <div className="flag-text">
              <span className="flag-title">{FLAG_TITLE[flag.name] ?? flag.name}</span>
              <code className="flag-name">{flag.name}</code>
              <span className="flag-desc">{flag.description}</span>
              <span className="flag-meta">
                {flag.updatedBy === 'terraform'
                  ? 'valor inicial definido por Terraform'
                  : `cambiada por ${flag.updatedBy ?? '—'} a las ${time(flag.updatedAt)}`}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={flag.enabled}
              aria-label={`${FLAG_TITLE[flag.name] ?? flag.name}: ${flag.enabled ? 'activa' : 'inactiva'}`}
              className="switch"
              disabled={pending === flag.name}
              onClick={() => toggle(flag)}
              data-testid={`flag-toggle-${flag.name}`}
            >
              <span className="switch-knob" />
              <span className="switch-label">{flag.enabled ? 'ON' : 'OFF'}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      <p className="panel-foot">
        Un cambio aqui (o por AWS CLI sobre la tabla) se aplica en segundos, sin redesplegar, y solo en{' '}
        <b>{environment}</b>.
      </p>
    </section>
  );
}
