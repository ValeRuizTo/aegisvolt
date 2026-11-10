// Panel (a): estado de electrolineras y disponibilidad de conectores.
const STATUS_LABEL = { AVAILABLE: 'Disponible', RESERVED: 'Reservado', CHARGING: 'Cargando' };

export function StationsPanel({ stations, selection, onSelect }) {
  const total = stations.reduce((sum, s) => sum + s.connectors.length, 0);
  const available = stations.reduce((sum, s) => sum + s.availableConnectors, 0);

  return (
    <section className="panel panel-stations" aria-labelledby="stations-title">
      <div className="panel-head">
        <h2 id="stations-title">Electrolineras</h2>
        <span className="count" data-testid="available-count">
          {available} de {total} conectores disponibles
        </span>
      </div>

      <div className="stations">
        {stations.map((station) => (
          <article key={station.stationId} className="station">
            <header>
              <h3>{station.name}</h3>
              <p>
                {station.city} · {station.stationId}
              </p>
            </header>
            <ul className="connectors">
              {station.connectors.map((connector) => {
                const selected =
                  selection?.stationId === station.stationId && selection?.connectorId === connector.connectorId;
                const selectable = connector.status === 'AVAILABLE';
                return (
                  <li key={connector.connectorId}>
                    <button
                      type="button"
                      className={`connector status-${connector.status.toLowerCase()}${selected ? ' is-selected' : ''}`}
                      disabled={!selectable}
                      aria-pressed={selected}
                      onClick={() => onSelect({ stationId: station.stationId, connectorId: connector.connectorId })}
                      title={connector.reservedBy ? `SAGA ${connector.reservedBy}` : 'Seleccionar para reservar'}
                      data-testid={`connector-${station.stationId}-${connector.connectorId}`}
                    >
                      <span className="connector-id">{connector.connectorId}</span>
                      <span className="connector-spec">
                        {connector.type} · {connector.powerKw} kW{connector.ultraFast ? ' · ultra' : ''}
                      </span>
                      <span className="connector-status">{STATUS_LABEL[connector.status]}</span>
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
