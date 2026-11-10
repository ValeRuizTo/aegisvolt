// =============================================================================
// station-reservation-service :: acceso a datos (tabla aegisvolt-reservations-<env>)
//
// Modelo de items (clave pk / sk):
//   STATION#<stationId>   | META                -> datos de la electrolinera
//   STATION#<stationId>   | CONNECTOR#<id>      -> conector y su estado
//   RESERVATION#<sagaId>  | META                -> reserva creada por una SAGA
//
// Estados de un conector:  AVAILABLE -> RESERVED -> CHARGING -> AVAILABLE
//
// IDEMPOTENCIA: el sagaId es la clave de la reserva. Repetir cualquier
// operacion con el mismo sagaId produce el mismo resultado y no cambia nada
// la segunda vez. Se consigue con escrituras condicionales de DynamoDB
// (ConditionExpression), no con "leer y despues escribir".
// =============================================================================
import { GetCommand, ScanCommand, TransactWriteCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { conflict, notFound, badRequest, isConditionalCheckFailed, transactionCancellationCodes } from '@aegisvolt/common';

export const CONNECTOR_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  RESERVED: 'RESERVED',
  CHARGING: 'CHARGING',
});

export const RESERVATION_STATUS = Object.freeze({
  RESERVED: 'RESERVED', // conector bloqueado, esperando cobro y activacion
  CHARGING: 'CHARGING', // la SAGA termino bien: hay una carga en curso
  RELEASED: 'RELEASED', // compensacion: la SAGA fallo y se libero el conector
  COMPLETED: 'COMPLETED', // la carga termino normalmente
});

// Potencia minima para considerar un conector de "ultra-carga".
export const ULTRA_FAST_MIN_KW = 150;

const stationKey = (stationId) => `STATION#${stationId}`;
const connectorKey = (connectorId) => `CONNECTOR#${connectorId}`;
const reservationKey = (sagaId) => `RESERVATION#${sagaId}`;

export function createReservationRepository({ dynamo, tableName, lockTtlSeconds = 300, now = () => new Date() }) {
  // --------------------------------------------------------------------------
  // Consultas
  // --------------------------------------------------------------------------
  async function listStations() {
    // La tabla es pequena (decenas de items): un Scan filtrado es suficiente.
    const { Items = [] } = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :prefix)',
        ExpressionAttributeValues: { ':prefix': 'STATION#' },
      }),
    );

    const stations = new Map();
    for (const item of Items.filter((i) => i.sk === 'META')) {
      stations.set(item.stationId, { ...toStation(item), connectors: [] });
    }
    for (const item of Items.filter((i) => i.sk.startsWith('CONNECTOR#'))) {
      stations.get(item.stationId)?.connectors.push(toConnector(item, now()));
    }
    return [...stations.values()]
      .map((s) => ({ ...s, connectors: s.connectors.sort((a, b) => a.connectorId.localeCompare(b.connectorId)) }))
      .sort((a, b) => a.stationId.localeCompare(b.stationId));
  }

  async function getConnector(stationId, connectorId) {
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { pk: stationKey(stationId), sk: connectorKey(connectorId) } }),
    );
    return Item ? toConnector(Item, now()) : null;
  }

  async function getReservation(sagaId) {
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { pk: reservationKey(sagaId), sk: 'META' } }),
    );
    return Item ? toReservation(Item) : null;
  }

  // --------------------------------------------------------------------------
  // PASO 1 de la SAGA: reservar (bloqueo temporal del conector)
  // --------------------------------------------------------------------------
  async function reserve({ sagaId, stationId, connectorId, fleetId, fastCharge = false }) {
    const connector = await getConnector(stationId, connectorId);
    if (!connector) throw notFound('CONNECTOR_NOT_FOUND', `No existe el conector ${stationId}/${connectorId}`);
    if (fastCharge && connector.powerKw < ULTRA_FAST_MIN_KW) {
      throw badRequest(
        'CONNECTOR_NOT_ULTRA_FAST',
        `La ultra-carga requiere un conector de al menos ${ULTRA_FAST_MIN_KW} kW (este entrega ${connector.powerKw} kW)`,
      );
    }

    const current = now();
    const nowIso = current.toISOString();
    const lockExpiresAt = new Date(current.getTime() + lockTtlSeconds * 1000).toISOString();

    try {
      // Las dos escrituras son atomicas (todo o nada) y ambas condicionales.
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // [0] Bloquear el conector SOLO si esta libre, o si su bloqueo
              //     temporal ya vencio (reserva abandonada).
              Update: {
                TableName: tableName,
                Key: { pk: stationKey(stationId), sk: connectorKey(connectorId) },
                UpdateExpression:
                  'SET #status = :reserved, reservedBy = :sagaId, lockExpiresAt = :expires, updatedAt = :now',
                ConditionExpression:
                  'attribute_exists(pk) AND (#status = :available OR (#status = :reserved AND lockExpiresAt < :now))',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':reserved': CONNECTOR_STATUS.RESERVED,
                  ':available': CONNECTOR_STATUS.AVAILABLE,
                  ':sagaId': sagaId,
                  ':expires': lockExpiresAt,
                  ':now': nowIso,
                },
              },
            },
            {
              // [1] Registrar la reserva SOLO si esta SAGA no reservo antes.
              Put: {
                TableName: tableName,
                Item: {
                  pk: reservationKey(sagaId),
                  sk: 'META',
                  sagaId,
                  stationId,
                  connectorId,
                  fleetId,
                  fastCharge,
                  powerKw: connector.powerKw,
                  status: RESERVATION_STATUS.RESERVED,
                  lockExpiresAt,
                  createdAt: nowIso,
                  updatedAt: nowIso,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (err) {
      const codes = transactionCancellationCodes(err);
      if (!codes) throw err;

      // Peticion repetida (reintento o mensaje duplicado): la reserva de esta
      // SAGA ya existe. Se devuelve el resultado original sin tocar nada.
      const existing = await getReservation(sagaId);
      if (existing) {
        if (existing.status === RESERVATION_STATUS.RELEASED) {
          throw conflict('RESERVATION_ALREADY_RELEASED', 'Esta SAGA ya fue compensada; no se puede volver a reservar');
        }
        return { reservation: existing, idempotentReplay: true };
      }

      const latest = await getConnector(stationId, connectorId);
      throw conflict('CONNECTOR_NOT_AVAILABLE', `El conector ${stationId}/${connectorId} no esta disponible`, {
        currentStatus: latest?.status,
      });
    }

    return { reservation: await getReservation(sagaId), idempotentReplay: false };
  }

  // --------------------------------------------------------------------------
  // Confirmacion: la carga inicio -> el conector pasa a CHARGING
  // --------------------------------------------------------------------------
  async function confirm(sagaId) {
    const reservation = await getReservation(sagaId);
    if (!reservation) throw notFound('RESERVATION_NOT_FOUND', `No existe reserva para la SAGA ${sagaId}`);
    if (reservation.status === RESERVATION_STATUS.CHARGING) return { reservation, idempotentReplay: true };
    if (reservation.status !== RESERVATION_STATUS.RESERVED) {
      throw conflict('RESERVATION_NOT_ACTIVE', `La reserva esta en estado ${reservation.status}`);
    }

    const nowIso = now().toISOString();
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: stationKey(reservation.stationId), sk: connectorKey(reservation.connectorId) },
          UpdateExpression: 'SET #status = :charging, updatedAt = :now REMOVE lockExpiresAt',
          // Solo la SAGA duena del bloqueo puede confirmar.
          ConditionExpression: 'reservedBy = :sagaId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':charging': CONNECTOR_STATUS.CHARGING, ':sagaId': sagaId, ':now': nowIso },
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      throw conflict('RESERVATION_LOCK_LOST', 'El bloqueo del conector ya no pertenece a esta SAGA');
    }
    await setReservationStatus(sagaId, RESERVATION_STATUS.CHARGING, nowIso);
    return { reservation: await getReservation(sagaId), idempotentReplay: false };
  }

  // --------------------------------------------------------------------------
  // COMPENSACION del paso 1 (y cierre normal): liberar el conector
  //
  // finalStatus = RELEASED  -> transaccion compensatoria (la SAGA fallo)
  // finalStatus = COMPLETED -> la carga termino normalmente
  // --------------------------------------------------------------------------
  async function finish(sagaId, finalStatus, reason = null) {
    const reservation = await getReservation(sagaId);
    if (!reservation) {
      // Compensar algo que nunca llego a ocurrir es valido: no hay nada que deshacer.
      return { released: false, alreadyReleased: true, reservation: null };
    }

    const nowIso = now().toISOString();
    let connectorReleased = true;
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: stationKey(reservation.stationId), sk: connectorKey(reservation.connectorId) },
          UpdateExpression: 'SET #status = :available, updatedAt = :now REMOVE reservedBy, lockExpiresAt',
          // CLAVE DE LA IDEMPOTENCIA: solo se libera si el conector SIGUE
          // bloqueado por ESTA saga. Si la compensacion llega dos veces, o si
          // el conector ya fue reservado por otra SAGA, la segunda no hace nada
          // (y jamas libera la reserva de otro cliente).
          ConditionExpression: 'reservedBy = :sagaId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':available': CONNECTOR_STATUS.AVAILABLE, ':sagaId': sagaId, ':now': nowIso },
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      connectorReleased = false;
    }

    const alreadyFinal = [RESERVATION_STATUS.RELEASED, RESERVATION_STATUS.COMPLETED].includes(reservation.status);
    if (!alreadyFinal) {
      await setReservationStatus(sagaId, finalStatus, nowIso, reason);
    }
    return {
      released: connectorReleased,
      alreadyReleased: !connectorReleased,
      reservation: await getReservation(sagaId),
    };
  }

  async function setReservationStatus(sagaId, status, nowIso, reason = null) {
    await dynamo.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: reservationKey(sagaId), sk: 'META' },
        UpdateExpression: 'SET #status = :status, updatedAt = :now, statusReason = :reason REMOVE lockExpiresAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': status, ':now': nowIso, ':reason': reason },
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Datos iniciales (idempotente: solo inserta lo que no existe)
  // --------------------------------------------------------------------------
  async function seed(stations) {
    const nowIso = now().toISOString();
    const putIfAbsent = (Item) =>
      dynamo
        .send(new PutCommand({ TableName: tableName, Item, ConditionExpression: 'attribute_not_exists(pk)' }))
        .then(() => 1)
        .catch((err) => {
          if (isConditionalCheckFailed(err)) return 0;
          throw err;
        });

    let created = 0;
    for (const station of stations) {
      created += await putIfAbsent({
        pk: stationKey(station.stationId),
        sk: 'META',
        stationId: station.stationId,
        name: station.name,
        city: station.city,
        address: station.address,
        createdAt: nowIso,
      });
      for (const connector of station.connectors) {
        created += await putIfAbsent({
          pk: stationKey(station.stationId),
          sk: connectorKey(connector.connectorId),
          stationId: station.stationId,
          connectorId: connector.connectorId,
          type: connector.type,
          powerKw: connector.powerKw,
          status: CONNECTOR_STATUS.AVAILABLE,
          updatedAt: nowIso,
        });
      }
    }
    return created;
  }

  return { listStations, getConnector, getReservation, reserve, confirm, finish, seed };
}

// ----------------------------------------------------------------------------
// Conversion item DynamoDB -> objeto de dominio
// ----------------------------------------------------------------------------
function toStation(item) {
  return { stationId: item.stationId, name: item.name, city: item.city, address: item.address };
}

function toConnector(item, currentDate) {
  // Un bloqueo temporal vencido equivale a "disponible": nadie confirmo la reserva.
  const lockExpired =
    item.status === CONNECTOR_STATUS.RESERVED && item.lockExpiresAt && item.lockExpiresAt < currentDate.toISOString();
  return {
    stationId: item.stationId,
    connectorId: item.connectorId,
    type: item.type,
    powerKw: item.powerKw,
    ultraFast: item.powerKw >= ULTRA_FAST_MIN_KW,
    status: lockExpired ? CONNECTOR_STATUS.AVAILABLE : item.status,
    reservedBy: lockExpired ? null : (item.reservedBy ?? null),
    lockExpiresAt: lockExpired ? null : (item.lockExpiresAt ?? null),
    updatedAt: item.updatedAt ?? null,
  };
}

function toReservation(item) {
  return {
    sagaId: item.sagaId,
    stationId: item.stationId,
    connectorId: item.connectorId,
    fleetId: item.fleetId,
    fastCharge: item.fastCharge === true,
    powerKw: item.powerKw,
    status: item.status,
    statusReason: item.statusReason ?? null,
    lockExpiresAt: item.lockExpiresAt ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}
