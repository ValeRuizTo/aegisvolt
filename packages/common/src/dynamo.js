// =============================================================================
// Cliente de DynamoDB
//
// DynamoDBDocumentClient convierte automaticamente entre objetos JavaScript y
// el formato tipado de DynamoDB ({ S: "texto" }, { N: "12" } ...).
// El endpoint sale de la configuracion: Floci en local, AWS real si esta vacio.
// =============================================================================
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export function createDynamoClient(config) {
  const base = new DynamoDBClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    maxAttempts: 3,
  });
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** true si el error es una condicion (ConditionExpression) no cumplida. */
export function isConditionalCheckFailed(err) {
  return err?.name === 'ConditionalCheckFailedException';
}

/**
 * Para TransactWriteItems: devuelve, por cada operacion de la transaccion, el
 * codigo de cancelacion ("None", "ConditionalCheckFailed", ...), o null si el
 * error no es una cancelacion de transaccion.
 */
export function transactionCancellationCodes(err) {
  if (err?.name !== 'TransactionCanceledException') return null;
  return (err.CancellationReasons ?? []).map((reason) => reason?.Code ?? 'None');
}
