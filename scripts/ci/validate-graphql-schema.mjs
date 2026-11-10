// Valida el esquema GraphQL (job lint-build): sintaxis correcta y presencia de
// las operaciones que la especificacion exige. Falla el pipeline si no cumple.
import { readFileSync } from 'node:fs';
import { buildSchema } from 'graphql';

const file = new URL('../../services/graphql-gateway/src/schema.graphql', import.meta.url);
let schema;
try {
  schema = buildSchema(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Esquema GraphQL invalido: ${err.message}`);
  process.exit(1);
}

const required = {
  Query: ['stations', 'telemetry', 'featureFlags', 'sagas', 'wallets', 'chargingSessions', 'environment'],
  Mutation: ['reserveAndCharge', 'stopCharging', 'setFeatureFlag', 'compensateSaga', 'topUpWallet'],
};
const missing = [];
for (const [typeName, fields] of Object.entries(required)) {
  const available = Object.keys(schema.getType(typeName)?.getFields() ?? {});
  for (const field of fields) if (!available.includes(field)) missing.push(`${typeName}.${field}`);
}
if (missing.length > 0) {
  console.error(`Faltan operaciones obligatorias en el esquema: ${missing.join(', ')}`);
  process.exit(1);
}
const count = (name) => Object.keys(schema.getType(name).getFields()).length;
console.log(`Esquema GraphQL valido: ${count('Query')} queries, ${count('Mutation')} mutations`);
