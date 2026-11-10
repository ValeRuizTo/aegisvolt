// Electrolineras y conectores iniciales. Se insertan al arrancar el servicio
// solo si no existen (ver repository.seed).
export const SEED_STATIONS = [
  {
    stationId: 'ST-BOG-01',
    name: 'Electrolinera Calle 80',
    city: 'Bogota',
    address: 'Av. Calle 80 # 69-15',
    connectors: [
      { connectorId: 'C1', type: 'CCS2', powerKw: 150 },
      { connectorId: 'C2', type: 'CCS2', powerKw: 150 },
      { connectorId: 'C3', type: 'CCS2', powerKw: 60 },
      { connectorId: 'C4', type: 'TYPE2', powerKw: 22 },
    ],
  },
  {
    stationId: 'ST-MED-01',
    name: 'Electrolinera El Poblado',
    city: 'Medellin',
    address: 'Cra. 43A # 7-50',
    connectors: [
      { connectorId: 'C1', type: 'CCS2', powerKw: 180 },
      { connectorId: 'C2', type: 'CHADEMO', powerKw: 50 },
      { connectorId: 'C3', type: 'TYPE2', powerKw: 22 },
    ],
  },
  {
    stationId: 'ST-CAL-01',
    name: 'Hub Logistico Yumbo',
    city: 'Cali',
    address: 'Zona Industrial Yumbo, Bodega 12',
    connectors: [
      { connectorId: 'C1', type: 'CCS2', powerKw: 150 },
      { connectorId: 'C2', type: 'CCS2', powerKw: 60 },
    ],
  },
];
