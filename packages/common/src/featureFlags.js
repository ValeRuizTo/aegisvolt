// =============================================================================
// Feature Flags por ambiente (implementacion propia sobre DynamoDB)
//
// Cada ambiente tiene SU tabla: aegisvolt-feature-flags-dev | -test | -prod.
// Un servicio desplegado en dev solo conoce la tabla de dev, por lo que es
// fisicamente imposible que un cambio de flag en dev afecte a prod.
//
// Item:  { flag_name, enabled, description, updated_at, updated_by }
//
// El valor se cachea unos segundos (flagCacheTtlMs, 3 s por defecto) para no
// consultar DynamoDB en cada peticion. Por eso un cambio de flag se refleja
// "en caliente", sin redesplegar ni reiniciar pods, en cuestion de segundos.
// =============================================================================
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export const FLAGS = Object.freeze({
  DYNAMIC_SURGE_PRICING: 'ENABLE_DYNAMIC_SURGE_PRICING',
  FAST_CHARGE_BOOST: 'ENABLE_FAST_CHARGE_BOOST',
  SIMULATE_CHARGER_HARDWARE_FAULT: 'SIMULATE_CHARGER_HARDWARE_FAULT',
});

export function createFeatureFlags({ dynamo, tableName, ttlMs = 3000, logger, now = Date.now }) {
  const cache = new Map(); // flag_name -> { value, expiresAt }

  async function isEnabled(flagName) {
    const cached = cache.get(flagName);
    if (cached && cached.expiresAt > now()) return cached.value;

    let value;
    try {
      const { Item } = await dynamo.send(new GetCommand({ TableName: tableName, Key: { flag_name: flagName } }));
      value = Item?.enabled === true;
    } catch (err) {
      // Fallo seguro: si no se puede leer la flag, se considera APAGADA.
      logger?.warn('No se pudo leer la feature flag; se asume desactivada', {
        flag: flagName,
        error: err.message,
      });
      value = false;
    }
    cache.set(flagName, { value, expiresAt: now() + ttlMs });
    return value;
  }

  async function list() {
    const { Items = [] } = await dynamo.send(new ScanCommand({ TableName: tableName }));
    return Items.map(toFlag).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function set(flagName, enabled, updatedBy = 'api') {
    const { Attributes } = await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { flag_name: flagName },
        UpdateExpression: 'SET enabled = :enabled, updated_at = :at, updated_by = :by',
        // Solo se pueden cambiar flags que ya existen (las declara Terraform).
        ConditionExpression: 'attribute_exists(flag_name)',
        ExpressionAttributeValues: {
          ':enabled': enabled,
          ':at': new Date(now()).toISOString(),
          ':by': updatedBy,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    cache.delete(flagName);
    logger?.info('Feature flag actualizada', { flag: flagName, enabled, updated_by: updatedBy });
    return toFlag(Attributes);
  }

  return { isEnabled, list, set };
}

function toFlag(item) {
  return {
    name: item.flag_name,
    enabled: item.enabled === true,
    description: item.description ?? '',
    updatedAt: item.updated_at ?? null,
    updatedBy: item.updated_by ?? null,
  };
}
