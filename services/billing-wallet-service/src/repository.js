// =============================================================================
// billing-wallet-service :: acceso a datos (tabla aegisvolt-billing-<env>)
//
// Modelo de items (clave pk / sk):
//   WALLET#<fleetId> | BALANCE                -> saldo de la flota
//   WALLET#<fleetId> | TX#<sagaId>#CHARGE     -> cobro (retencion) de una SAGA
//   WALLET#<fleetId> | TX#<sagaId>#REFUND     -> reembolso (evento de reversion)
//
// IDEMPOTENCIA: la clave del movimiento contiene el sagaId. DynamoDB no puede
// almacenar dos items con la misma clave, asi que:
//   * un cobro repetido NO descuenta dos veces,
//   * un reembolso repetido NO devuelve el dinero dos veces.
// El movimiento y el cambio de saldo van en UNA transaccion (TransactWriteItems):
// o se escriben ambos o ninguno.
// =============================================================================
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DomainError, notFound, isConditionalCheckFailed, transactionCancellationCodes } from '@aegisvolt/common';

const walletKey = (fleetId) => `WALLET#${fleetId}`;
const chargeKey = (sagaId) => `TX#${sagaId}#CHARGE`;
const refundKey = (sagaId) => `TX#${sagaId}#REFUND`;

export function createBillingRepository({ dynamo, tableName, now = () => new Date() }) {
  // --------------------------------------------------------------------------
  // Consultas
  // --------------------------------------------------------------------------
  async function getWallet(fleetId) {
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { pk: walletKey(fleetId), sk: 'BALANCE' }, ConsistentRead: true }),
    );
    return Item ? toWallet(Item) : null;
  }

  async function listWallets() {
    const { Items = [] } = await dynamo.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'sk = :balance',
        ExpressionAttributeValues: { ':balance': 'BALANCE' },
      }),
    );
    return Items.map(toWallet).sort((a, b) => a.fleetId.localeCompare(b.fleetId));
  }

  async function listTransactions(fleetId) {
    const { Items = [] } = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tx)',
        ExpressionAttributeValues: { ':pk': walletKey(fleetId), ':tx': 'TX#' },
        ConsistentRead: true,
      }),
    );
    return Items.map(toTransaction).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function getTransaction(fleetId, sk) {
    const { Item } = await dynamo.send(
      new GetCommand({ TableName: tableName, Key: { pk: walletKey(fleetId), sk }, ConsistentRead: true }),
    );
    return Item ? toTransaction(Item) : null;
  }

  // --------------------------------------------------------------------------
  // PASO 2 de la SAGA: cobro (descuenta el saldo estimado)
  // --------------------------------------------------------------------------
  async function charge({ sagaId, fleetId, amount, quote, correlationId }) {
    const nowIso = now().toISOString();
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // [0] Registrar el cobro SOLO si esta SAGA no cobro antes.
              Put: {
                TableName: tableName,
                Item: {
                  pk: walletKey(fleetId),
                  sk: chargeKey(sagaId),
                  transactionId: `${sagaId}#CHARGE`,
                  type: 'CHARGE',
                  status: 'CHARGED',
                  sagaId,
                  fleetId,
                  amount,
                  quote,
                  correlationId,
                  createdAt: nowIso,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              // [1] Descontar SOLO si la billetera existe y tiene fondos.
              //     La verificacion de fondos y el descuento son una sola
              //     operacion atomica: dos cobros simultaneos no pueden dejar
              //     el saldo en negativo.
              Update: {
                TableName: tableName,
                Key: { pk: walletKey(fleetId), sk: 'BALANCE' },
                UpdateExpression: 'SET balance = balance - :amount, updatedAt = :now',
                ConditionExpression: 'attribute_exists(pk) AND balance >= :amount',
                ExpressionAttributeValues: { ':amount': amount, ':now': nowIso },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const codes = transactionCancellationCodes(err);
      if (!codes) throw err;

      // Cobro repetido: se devuelve el resultado original, sin descontar otra vez.
      if (codes[0] === 'ConditionalCheckFailed') {
        const existing = await getTransaction(fleetId, chargeKey(sagaId));
        return { transaction: existing, wallet: await getWallet(fleetId), idempotentReplay: true };
      }

      const wallet = await getWallet(fleetId);
      if (!wallet) throw notFound('WALLET_NOT_FOUND', `No existe billetera para la flota ${fleetId}`);
      throw new DomainError(
        'INSUFFICIENT_FUNDS',
        `Fondos insuficientes: saldo ${wallet.balance} ${wallet.currency}, se requieren ${amount}`,
        { status: 402, details: { balance: wallet.balance, required: amount } },
      );
    }

    return {
      transaction: await getTransaction(fleetId, chargeKey(sagaId)),
      wallet: await getWallet(fleetId),
      idempotentReplay: false,
    };
  }

  // --------------------------------------------------------------------------
  // COMPENSACION del paso 2: reembolso + evento de reversion
  // --------------------------------------------------------------------------
  async function refund({ sagaId, fleetId, reason, correlationId }) {
    const original = await getTransaction(fleetId, chargeKey(sagaId));
    if (!original) {
      // Nunca se cobro: no hay nada que reembolsar. Responder OK permite que la
      // SAGA siga compensando los pasos anteriores.
      return { refunded: false, alreadyRefunded: false, nothingToRefund: true, wallet: await getWallet(fleetId) };
    }

    const nowIso = now().toISOString();
    try {
      await dynamo.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // [0] Evento de reversion. Si ya existe, la transaccion completa
              //     se cancela y el saldo NO se vuelve a incrementar.
              Put: {
                TableName: tableName,
                Item: {
                  pk: walletKey(fleetId),
                  sk: refundKey(sagaId),
                  transactionId: `${sagaId}#REFUND`,
                  type: 'REFUND',
                  status: 'REFUNDED',
                  sagaId,
                  fleetId,
                  amount: original.amount,
                  reason,
                  compensates: original.transactionId,
                  correlationId,
                  createdAt: nowIso,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              // [1] Devolver exactamente lo cobrado.
              Update: {
                TableName: tableName,
                Key: { pk: walletKey(fleetId), sk: 'BALANCE' },
                UpdateExpression: 'SET balance = balance + :amount, updatedAt = :now',
                ConditionExpression: 'attribute_exists(pk)',
                ExpressionAttributeValues: { ':amount': original.amount, ':now': nowIso },
              },
            },
            {
              // [2] Marcar el cobro original como reembolsado.
              Update: {
                TableName: tableName,
                Key: { pk: walletKey(fleetId), sk: chargeKey(sagaId) },
                UpdateExpression: 'SET #status = :refunded, refundedAt = :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':refunded': 'REFUNDED', ':now': nowIso },
              },
            },
          ],
        }),
      );
    } catch (err) {
      const codes = transactionCancellationCodes(err);
      if (!codes) throw err;
      if (codes[0] === 'ConditionalCheckFailed') {
        // Compensacion duplicada: ya se reembolso antes.
        return {
          refunded: false,
          alreadyRefunded: true,
          nothingToRefund: false,
          transaction: await getTransaction(fleetId, refundKey(sagaId)),
          wallet: await getWallet(fleetId),
        };
      }
      throw err;
    }

    return {
      refunded: true,
      alreadyRefunded: false,
      nothingToRefund: false,
      transaction: await getTransaction(fleetId, refundKey(sagaId)),
      wallet: await getWallet(fleetId),
    };
  }

  // --------------------------------------------------------------------------
  // Recarga manual de saldo
  // --------------------------------------------------------------------------
  async function topUp(fleetId, amount) {
    try {
      const { Attributes } = await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: walletKey(fleetId), sk: 'BALANCE' },
          UpdateExpression: 'SET balance = balance + :amount, updatedAt = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':amount': amount, ':now': now().toISOString() },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toWallet(Attributes);
    } catch (err) {
      if (isConditionalCheckFailed(err)) throw notFound('WALLET_NOT_FOUND', `No existe billetera para la flota ${fleetId}`);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Datos iniciales (idempotente)
  // --------------------------------------------------------------------------
  async function seed(wallets) {
    const nowIso = now().toISOString();
    let created = 0;
    for (const wallet of wallets) {
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: walletKey(wallet.fleetId),
              sk: 'BALANCE',
              fleetId: wallet.fleetId,
              fleetName: wallet.fleetName,
              balance: wallet.balance,
              currency: 'COP',
              createdAt: nowIso,
              updatedAt: nowIso,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
        created += 1;
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }
    }
    return created;
  }

  return { getWallet, listWallets, listTransactions, charge, refund, topUp, seed };
}

function toWallet(item) {
  return {
    fleetId: item.fleetId,
    fleetName: item.fleetName,
    balance: item.balance,
    currency: item.currency,
    updatedAt: item.updatedAt,
  };
}

function toTransaction(item) {
  return {
    transactionId: item.transactionId,
    type: item.type,
    status: item.status,
    sagaId: item.sagaId,
    fleetId: item.fleetId,
    amount: item.amount,
    reason: item.reason ?? null,
    quote: item.quote ?? null,
    correlationId: item.correlationId ?? null,
    createdAt: item.createdAt,
    refundedAt: item.refundedAt ?? null,
  };
}
