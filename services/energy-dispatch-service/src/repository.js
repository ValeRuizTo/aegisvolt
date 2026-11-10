// =============================================================================
// energy-dispatch-service :: acceso a datos (tabla aegisvolt-dispatch-<env>)
//
// Modelo de items (clave pk / sk):
//   SESSION#<sagaId> | META                 -> sesion de carga
//   SESSION#<sagaId> | TELEMETRY#<000123>   -> muestra de telemetria numero 123
//
// Estados de una sesion: ACTIVE -> STOPPED     (o FAILED si el cargador fallo)
// =============================================================================
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailed } from '@aegisvolt/common';

export const SESSION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  STOPPED: 'STOPPED',
  FAILED: 'FAILED',
});

const sessionKey = (sagaId) => `SESSION#${sagaId}`;
const telemetryKey = (index) => `TELEMETRY#${String(index).padStart(6, '0')}`;

export function createDispatchRepository({ dynamo, tableName, now = () => new Date() }) {
  async function getSession(sagaId) {
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { pk: sessionKey(sagaId), sk: 'META' }, ConsistentRead: true }),
    );
    return Item ? toSession(Item) : null;
  }

  async function listSessions({ status } = {}) {
    const { Items = [] } = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: status ? 'sk = :meta AND #status = :status' : 'sk = :meta',
        ExpressionAttributeNames: status ? { '#status': 'status' } : undefined,
        ExpressionAttributeValues: status ? { ':meta': 'META', ':status': status } : { ':meta': 'META' },
      }),
    );
    return Items.map(toSession).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Crea la sesion SOLO si no existe otra para la misma SAGA.
   * @returns {{ session, created }}  created=false => peticion repetida.
   */
  async function createSession(session) {
    const nowIso = now().toISOString();
    try {
      await dynamo.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: sessionKey(session.sagaId), sk: 'META', ...session, createdAt: nowIso, updatedAt: nowIso },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { session: await getSession(session.sagaId), created: true };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      return { session: await getSession(session.sagaId), created: false };
    }
  }

  /** Pasa la sesion de ACTIVE a STOPPED. Idempotente. */
  async function stopSession(sagaId, reason) {
    const nowIso = now().toISOString();
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: sessionKey(sagaId), sk: 'META' },
          UpdateExpression: 'SET #status = :stopped, stoppedAt = :now, stopReason = :reason, updatedAt = :now',
          ConditionExpression: '#status = :active',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':stopped': SESSION_STATUS.STOPPED,
            ':active': SESSION_STATUS.ACTIVE,
            ':now': nowIso,
            ':reason': reason,
          },
        }),
      );
      return { session: await getSession(sagaId), stopped: true };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      // No estaba activa (ya detenida, fallida o inexistente): nada que hacer.
      return { session: await getSession(sagaId), stopped: false };
    }
  }

  /**
   * Guarda una muestra de telemetria. La clave incluye el numero de muestra,
   * de modo que la misma muestra escrita por dos replicas solo se guarda una vez.
   */
  async function putTelemetrySample(sagaId, sample) {
    try {
      await dynamo.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: sessionKey(sagaId), sk: telemetryKey(sample.sampleIndex), sagaId, ...sample },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async function listTelemetry(sagaId, { limit = 30 } = {}) {
    const { Items = [] } = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': sessionKey(sagaId), ':prefix': 'TELEMETRY#' },
        ScanIndexForward: false, // las mas recientes primero
        Limit: limit,
      }),
    );
    return Items.map(toSample).reverse();
  }

  return { getSession, listSessions, createSession, stopSession, putTelemetrySample, listTelemetry };
}

function toSession(item) {
  return {
    sagaId: item.sagaId,
    sessionId: item.sagaId,
    stationId: item.stationId,
    connectorId: item.connectorId,
    fleetId: item.fleetId,
    powerKw: item.powerKw,
    targetKwh: item.targetKwh,
    status: item.status,
    failureReason: item.failureReason ?? null,
    stopReason: item.stopReason ?? null,
    startedAt: item.startedAt ?? null,
    stoppedAt: item.stoppedAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toSample(item) {
  return {
    sampleIndex: item.sampleIndex,
    recordedAt: item.recordedAt,
    kwhDelivered: item.kwhDelivered,
    powerKw: item.powerKw,
    voltage: item.voltage,
    currentAmps: item.currentAmps,
    connectorTempC: item.connectorTempC,
    progressPercent: item.progressPercent,
    finished: item.finished === true,
  };
}
