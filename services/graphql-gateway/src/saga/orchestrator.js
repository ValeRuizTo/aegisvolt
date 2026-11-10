// =============================================================================
// ORQUESTADOR SAGA (generico)
//
// Una SAGA sustituye a una transaccion ACID cuando los datos estan repartidos
// en varios servicios/bases de datos. Es una secuencia de transacciones
// LOCALES; si una falla, se deshace el efecto de las anteriores ejecutando sus
// TRANSACCIONES COMPENSATORIAS en orden inverso.
//
// Variante implementada: ORQUESTACION. Un componente central (este) conoce el
// flujo completo, llama a cada servicio y decide cuando compensar.
//
// Una definicion de SAGA es una lista de pasos:
//   { name, service, action(ctx), compensation: { name, run(ctx) } | null }
//
// Garantias de este orquestador:
//   1. Cada cambio de estado se PERSISTE antes de continuar (registro de la
//      SAGA en DynamoDB). Si el proceso muere a mitad, el registro muestra
//      exactamente hasta donde se llego (SAGA "huerfana", recuperable).
//   2. Las compensaciones se ejecutan en ORDEN INVERSO al de los pasos.
//   3. Las compensaciones se REINTENTAN (deben terminar); por eso tienen que
//      ser idempotentes en los servicios.
//   4. Un paso que fallo de forma AMBIGUA (timeout: no sabemos si se ejecuto)
//      tambien se compensa. Compensar algo que no ocurrio es inofensivo.
// =============================================================================

export const SAGA_STATUS = Object.freeze({
  STARTED: 'STARTED', // en curso (o huerfana si lleva mucho tiempo asi)
  COMPLETED: 'COMPLETED', // todos los pasos terminaron bien
  COMPENSATING: 'COMPENSATING', // un paso fallo; deshaciendo los anteriores
  COMPENSATED: 'COMPENSATED', // rollback distribuido completo
  COMPENSATION_FAILED: 'COMPENSATION_FAILED', // una compensacion no pudo completarse
});

export const STEP_STATUS = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
});

export const COMPENSATION_STATUS = Object.freeze({
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  COMPENSATED: 'COMPENSATED',
  FAILED: 'FAILED',
});

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSagaOrchestrator({
  store,
  logger,
  environment = 'local',
  actionAttempts = 2, // reintentos de un paso ante fallos transitorios
  compensationAttempts = 4, // reintentos de una compensacion
  backoffMs = 200,
  sleep = defaultSleep,
  now = () => new Date(),
}) {
  const nowIso = () => now().toISOString();

  // --------------------------------------------------------------------------
  // Ejecutar una SAGA nueva
  // --------------------------------------------------------------------------
  async function execute(definition, { sagaId, input, correlationId }) {
    const saga = {
      sagaId,
      type: definition.type,
      status: SAGA_STATUS.STARTED,
      environment,
      correlationId,
      input,
      context: {}, // datos que un paso deja para los siguientes
      steps: definition.steps.map((step) => ({
        name: step.name,
        service: step.service,
        status: STEP_STATUS.PENDING,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        compensation: step.compensation
          ? { name: step.compensation.name, status: COMPENSATION_STATUS.NOT_REQUIRED, attempts: 0, finishedAt: null, error: null }
          : null,
      })),
      failure: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
    };

    // create() es condicional: si ya existe una SAGA con este id (mutacion
    // repetida con la misma clave de idempotencia) se devuelve la existente.
    const created = await store.create(saga);
    if (!created) {
      logger.info('SAGA ya existente: se devuelve sin re-ejecutar', { saga_id: sagaId });
      return store.get(sagaId);
    }
    logger.info('SAGA iniciada', { saga_id: sagaId, saga_type: saga.type, saga_status: saga.status });

    for (let index = 0; index < definition.steps.length; index += 1) {
      const definitionStep = definition.steps[index];
      const step = saga.steps[index];

      step.status = STEP_STATUS.RUNNING;
      step.startedAt = nowIso();
      await persist(saga);

      try {
        const result = await runWithRetries(
          () => definitionStep.action({ sagaId, input, context: saga.context }),
          { attempts: actionAttempts, shouldRetry: (err) => err.ambiguous === true, onAttempt: () => (step.attempts += 1) },
        );
        Object.assign(saga.context, result ?? {});
        step.status = STEP_STATUS.SUCCEEDED;
        step.finishedAt = nowIso();
        await persist(saga);
        logger.info('Paso de SAGA completado', { saga_id: sagaId, saga_step: step.name, target_service: step.service });
      } catch (err) {
        step.status = STEP_STATUS.FAILED;
        step.finishedAt = nowIso();
        step.error = err.message;
        saga.failure = { step: step.name, code: err.code ?? 'UNKNOWN_ERROR', message: err.message };
        logger.error('Paso de SAGA fallido: se inicia la compensacion', {
          saga_id: sagaId,
          saga_step: step.name,
          target_service: step.service,
          error_code: saga.failure.code,
          error: err.message,
          ambiguous: err.ambiguous === true,
        });

        // Que hay que deshacer: los pasos anteriores (ya confirmados) y, si el
        // fallo fue ambiguo, tambien el paso que fallo.
        const lastToCompensate = err.ambiguous === true ? index : index - 1;
        for (let i = 0; i <= lastToCompensate; i += 1) {
          if (saga.steps[i].compensation) saga.steps[i].compensation.status = COMPENSATION_STATUS.PENDING;
        }
        return compensate(definition, saga);
      }
    }

    saga.status = SAGA_STATUS.COMPLETED;
    saga.finishedAt = nowIso();
    await persist(saga);
    logger.info('SAGA completada', { saga_id: sagaId, saga_status: saga.status });
    return saga;
  }

  // --------------------------------------------------------------------------
  // Rollback distribuido: compensaciones en orden inverso
  // --------------------------------------------------------------------------
  async function compensate(definition, saga) {
    saga.status = SAGA_STATUS.COMPENSATING;
    await persist(saga);

    let allCompensated = true;
    for (let index = definition.steps.length - 1; index >= 0; index -= 1) {
      const compensation = saga.steps[index].compensation;
      if (!compensation || compensation.status !== COMPENSATION_STATUS.PENDING) continue;

      const definitionStep = definition.steps[index];
      try {
        await runWithRetries(
          () =>
            definitionStep.compensation.run({
              sagaId: saga.sagaId,
              input: saga.input,
              context: saga.context,
              reason: saga.failure?.code ?? 'SAGA_FAILED',
            }),
          {
            attempts: compensationAttempts,
            // Un rechazo definitivo del servicio (4xx) no mejora reintentando.
            shouldRetry: (err) => err.ambiguous !== false,
            onAttempt: () => (compensation.attempts += 1),
          },
        );
        compensation.status = COMPENSATION_STATUS.COMPENSATED;
        compensation.error = null;
        logger.info('Compensacion ejecutada', {
          saga_id: saga.sagaId,
          saga_step: compensation.name,
          compensates: saga.steps[index].name,
          target_service: saga.steps[index].service,
          compensation: true,
        });
      } catch (err) {
        allCompensated = false;
        compensation.status = COMPENSATION_STATUS.FAILED;
        compensation.error = err.message;
        logger.error('Compensacion fallida tras agotar reintentos', {
          saga_id: saga.sagaId,
          saga_step: compensation.name,
          target_service: saga.steps[index].service,
          compensation: true,
          error: err.message,
        });
      }
      compensation.finishedAt = nowIso();
      await persist(saga);
    }

    saga.status = allCompensated ? SAGA_STATUS.COMPENSATED : SAGA_STATUS.COMPENSATION_FAILED;
    saga.finishedAt = nowIso();
    await persist(saga);
    logger[allCompensated ? 'warn' : 'error']('SAGA finalizada con rollback', {
      saga_id: saga.sagaId,
      saga_status: saga.status,
      failed_step: saga.failure?.step,
      error_code: saga.failure?.code,
    });
    return saga;
  }

  // --------------------------------------------------------------------------
  // Recuperacion de una SAGA que quedo a medias (huerfana)
  // --------------------------------------------------------------------------
  async function recover(definition, sagaId, { minAgeMs = 30000 } = {}) {
    const saga = await store.get(sagaId);
    if (!saga) return null;

    if ([SAGA_STATUS.COMPLETED, SAGA_STATUS.COMPENSATED].includes(saga.status)) {
      const error = new Error(`La SAGA ${sagaId} ya termino (${saga.status}); no hay nada que recuperar`);
      error.code = 'SAGA_ALREADY_FINISHED';
      throw error;
    }
    const ageMs = now().getTime() - new Date(saga.updatedAt).getTime();
    if (saga.status === SAGA_STATUS.STARTED && ageMs < minAgeMs) {
      const error = new Error(`La SAGA ${sagaId} sigue en ejecucion; espere antes de forzar su compensacion`);
      error.code = 'SAGA_IN_PROGRESS';
      throw error;
    }

    // Se marca para compensar todo paso que pudo dejar efectos y cuya
    // compensacion no este ya confirmada:
    //   * SUCCEEDED  -> se ejecuto: hay que deshacerlo.
    //   * RUNNING    -> el orquestador murio durante el paso: no sabemos si se
    //                   ejecuto (ambiguo), se compensa por si acaso.
    //   * FAILED     -> solo si su compensacion ya estaba pendiente o fallida.
    //                   Un rechazo definitivo (NOT_REQUIRED) no dejo efectos.
    for (const step of saga.steps) {
      if (!step.compensation || step.compensation.status === COMPENSATION_STATUS.COMPENSATED) continue;
      const interrupted = step.status === STEP_STATUS.RUNNING;
      const needsCompensation =
        step.status === STEP_STATUS.SUCCEEDED ||
        interrupted ||
        (step.status === STEP_STATUS.FAILED && step.compensation.status !== COMPENSATION_STATUS.NOT_REQUIRED);
      if (needsCompensation) step.compensation.status = COMPENSATION_STATUS.PENDING;
      if (interrupted) {
        step.status = STEP_STATUS.FAILED;
        step.error = 'Interrumpido: el orquestador se detuvo durante este paso';
      }
    }
    saga.failure ??= { step: 'ORCHESTRATOR', code: 'SAGA_ORPHANED', message: 'SAGA interrumpida y recuperada manualmente' };
    logger.warn('Recuperando SAGA huerfana', { saga_id: sagaId, previous_status: saga.status });
    return compensate(definition, saga);
  }

  // --------------------------------------------------------------------------
  // Utilidades
  // --------------------------------------------------------------------------
  async function persist(saga) {
    saga.updatedAt = nowIso();
    await store.save(saga);
  }

  async function runWithRetries(fn, { attempts, shouldRetry, onAttempt }) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      onAttempt?.();
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt === attempts || !shouldRetry(err)) break;
        await sleep(backoffMs * 2 ** (attempt - 1)); // espera exponencial
      }
    }
    throw lastError;
  }

  return { execute, recover };
}
