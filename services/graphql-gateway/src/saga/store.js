// =============================================================================
// Registro de SAGAs (tabla aegisvolt-sagas-<env>, propiedad del orquestador)
//
// Item:  pk = SAGA#<sagaId>, sk = META, + el estado completo de la SAGA.
//
// Es la "bitacora" de la transaccion distribuida: que pasos se ejecutaron, cual
// fallo y que compensaciones se aplicaron. La leen el panel de historial del
// frontend y el flujo de auditoria de Prefect.
// =============================================================================
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed } from '@aegisvolt/common';

const sagaKey = (sagaId) => ({ pk: `SAGA#${sagaId}`, sk: 'META' });

export function createDynamoSagaStore({ dynamo, tableName }) {
  return {
    /** Inserta la SAGA solo si no existe. Devuelve false si ya existia. */
    async create(saga) {
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...sagaKey(saga.sagaId), ...saga },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
        return true;
      } catch (err) {
        if (isConditionalCheckFailed(err)) return false;
        throw err;
      }
    },

    /** Sobrescribe el estado completo de la SAGA. */
    async save(saga) {
      await dynamo.send(new PutCommand({ TableName: tableName, Item: { ...sagaKey(saga.sagaId), ...saga } }));
    },

    async get(sagaId) {
      const { Item } = await dynamo.send(
        new GetCommand({ TableName: tableName, Key: sagaKey(sagaId), ConsistentRead: true }),
      );
      return Item ? stripKeys(Item) : null;
    },

    async list({ limit = 25 } = {}) {
      const items = [];
      let ExclusiveStartKey;
      do {
        const page = await dynamo.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
        items.push(...(page.Items ?? []));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items
        .map(stripKeys)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },
  };
}

/** Implementacion en memoria: la usan las pruebas unitarias del orquestador. */
export function createInMemorySagaStore() {
  const sagas = new Map();
  const clone = (value) => structuredClone(value);
  return {
    history: [], // cada save(), para verificar el orden de las transiciones
    async create(saga) {
      if (sagas.has(saga.sagaId)) return false;
      sagas.set(saga.sagaId, clone(saga));
      return true;
    },
    async save(saga) {
      sagas.set(saga.sagaId, clone(saga));
      this.history.push(clone(saga));
    },
    async get(sagaId) {
      return sagas.has(sagaId) ? clone(sagas.get(sagaId)) : null;
    },
    async list({ limit = 25 } = {}) {
      return [...sagas.values()].map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
    },
  };
}

function stripKeys({ pk: _pk, sk: _sk, ...saga }) {
  return saga;
}
