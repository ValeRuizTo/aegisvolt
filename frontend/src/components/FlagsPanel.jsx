// Ajustes del ambiente (feature flags). Cada ambiente tiene los suyos.
import { useState } from 'react';
import { gql, SET_FLAG_MUTATION, time } from '../api.js';
import { Icon } from '../icons.jsx';
import { ENV_NAMES, FLAG_ORDER, FLAG_TEXTS } from '../labels.js';

export function FlagsPanel({ flags, environment, onChange }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const ordered = [...flags].sort((a, b) => FLAG_ORDER.indexOf(a.name) - FLAG_ORDER.indexOf(b.name));

  async function toggle(flag) {
    setPending(flag.name);
    setError(null);
    try {
      await gql(SET_FLAG_MUTATION, { name: flag.name, enabled: !flag.enabled });
      await onChange();
    } catch {
      setError('No se pudo guardar el cambio. Inténtalo de nuevo.');
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="flags-title">
      <header className="panel-head">
        <h2 id="flags-title">
          <Icon name="sliders" />
          Ajustes del ambiente
        </h2>
      </header>
      <p className="panel-intro">Se aplican en unos segundos y solo en {ENV_NAMES[environment] ?? environment}.</p>

      <ul className="flags">
        {ordered.map((flag) => {
          const text = FLAG_TEXTS[flag.name] ?? { title: flag.name, description: flag.description };
          const descId = `flag-desc-${flag.name}`;
          return (
            <li key={flag.name} className={`flag${flag.enabled ? ' is-on' : ''}`} data-testid={`flag-${flag.name}`}>
              <div className="flag-text">
                <span className="flag-title">{text.title}</span>
                <span className="flag-desc" id={descId}>
                  {text.description}
                </span>
                <span className="flag-meta">
                  {flag.updatedBy === 'terraform' || !flag.updatedAt ? 'Valor inicial' : `Cambiado a las ${time(flag.updatedAt)}`}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={flag.enabled}
                aria-describedby={descId}
                aria-label={text.title}
                className="switch"
                disabled={pending === flag.name}
                onClick={() => toggle(flag)}
                data-testid={`flag-toggle-${flag.name}`}
              >
                <span className="switch-track" aria-hidden="true">
                  <span className="switch-knob" />
                </span>
                <span className="switch-label">{flag.enabled ? 'Activo' : 'Inactivo'}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="callout callout-bad" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}
