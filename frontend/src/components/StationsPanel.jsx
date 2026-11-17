// Electrolineras y disponibilidad de cada conector.
import { Icon } from '../icons.jsx';
import { CONNECTOR_STATUS } from '../labels.js';

export function StationsPanel({ stations, selection, onSelect }) {
  const total = stations.reduce((sum, s) => sum + s.connectors.length, 0);
  const available = stations.reduce((sum, s) => sum + s.availableConnectors, 0);

  return (
    <section className="panel" aria-labelledby="stations-title">
      <header className="panel-head">
        <h2 id="stations-title">
          <Icon name="pin" />
          Electrolineras
        </h2>
        <span className="panel-meta" data-testid="available-count">
          <strong>{available}</strong> de {total} conectores libres
        </span>
      </header>

      <div className="stations">
        {stations.map((station) => (
          <article key={station.stationId} className="station">
            <header className="station-head">
              <h3>{station.name}</h3>
              <p>{station.city}</p>
              <span className="station-free">
                {station.availableConnectors} {station.availableConnectors === 1 ? 'libre' : 'libres'}
              </span>
            </header>
            <ul className="connectors">
              {station.connectors.map((connector) => {
                const selected =
                  selection?.stationId === station.stationId && selection?.connectorId === connector.connectorId;
                const free = connector.status === 'AVAILABLE';
                return (
                  <li key={connector.connectorId}>
                    <button
                      type="button"
                      className={`connector is-${connector.status.toLowerCase()}${selected ? ' is-selected' : ''}`}
                      disabled={!free}
                      aria-pressed={selected}
                      aria-label={`Conector ${connector.connectorId}, ${connector.powerKw} kW, ${CONNECTOR_STATUS[connector.status]}${free ? '. Elegir para cargar' : ''}`}
                      onClick={() => onSelect({ stationId: station.stationId, connectorId: connector.connectorId })}
                      data-testid={`connector-${station.stationId}-${connector.connectorId}`}
                    >
                      <span className="connector-id">{connector.connectorId}</span>
                      <span className="connector-power">
                        {connector.powerKw} kW
                        {connector.ultraFast && <span className="connector-fast">Rápido</span>}
                      </span>
                      <span className="connector-type">{connector.type}</span>
                      <span className="connector-status">
                        <span className="dot" aria-hidden="true" />
                        {CONNECTOR_STATUS[connector.status]}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
