// Errores de negocio con codigo estable y estado HTTP asociado.
// El orquestador SAGA decide que hacer segun el "code" (no segun el texto).

export class DomainError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (code, message) => new DomainError(code, message, { status: 404 });
export const conflict = (code, message, details) => new DomainError(code, message, { status: 409, details });
export const badRequest = (code, message) => new DomainError(code, message, { status: 400 });

/** Lanza BAD_REQUEST si falta algun campo obligatorio en el cuerpo. */
export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length > 0) {
    throw badRequest('VALIDATION_ERROR', `Faltan campos obligatorios: ${missing.join(', ')}`);
  }
}
