// =============================================================================
// Definicion de la SAGA "Reservar y Activar Carga"
//
//  #  Paso (transaccion local)        Servicio                      Compensacion
//  1  RESERVE_CONNECTOR  -> RESERVED  station-reservation-service   RELEASE_CONNECTOR -> AVAILABLE
//  2  CHARGE_WALLET      -> saldo -=  billing-wallet-service        REFUND_WALLET     -> saldo +=
//  3  START_CHARGING     -> ACTIVE    energy-dispatch-service       STOP_CHARGING
//  4  CONFIRM_RESERVATION-> CHARGING  station-reservation-service   (ninguna: ultimo paso)
//
// Si falla el paso 3 (averia del cargador / flag SIMULATE_CHARGER_HARDWARE_FAULT):
//      REFUND_WALLET  y despues  RELEASE_CONNECTOR      (orden inverso)
// Si falla el paso 2 (fondos insuficientes):
//      RELEASE_CONNECTOR
//
// El sagaId viaja en todas las llamadas: es la clave de idempotencia con la
// que cada servicio reconoce una peticion repetida.
// =============================================================================

export const RESERVE_AND_CHARGE = 'RESERVE_AND_CHARGE';

export function buildReserveAndChargeSaga({ station, billing, dispatch }) {
  return {
    type: RESERVE_AND_CHARGE,
    steps: [
      {
        name: 'RESERVE_CONNECTOR',
        service: 'station-reservation-service',
        action: async ({ sagaId, input }) => {
          const { reservation } = await station.reserve({
            sagaId,
            stationId: input.stationId,
            connectorId: input.connectorId,
            fleetId: input.fleetId,
            fastCharge: input.fastCharge,
          });
          // La potencia del conector la necesita el paso 3.
          return { powerKw: reservation.powerKw };
        },
        compensation: {
          name: 'RELEASE_CONNECTOR',
          run: ({ sagaId, reason }) => station.release(sagaId, { reason }),
        },
      },
      {
        name: 'CHARGE_WALLET',
        service: 'billing-wallet-service',
        action: async ({ sagaId, input }) => {
          const { transaction } = await billing.charge({
            sagaId,
            fleetId: input.fleetId,
            estimatedKwh: input.estimatedKwh,
            fastCharge: input.fastCharge,
          });
          return { amount: transaction.amount, surgeApplied: transaction.quote?.surgeApplied ?? false };
        },
        compensation: {
          name: 'REFUND_WALLET',
          run: ({ sagaId, input, reason }) => billing.refund(sagaId, { fleetId: input.fleetId, reason }),
        },
      },
      {
        name: 'START_CHARGING',
        service: 'energy-dispatch-service',
        action: async ({ sagaId, input, context }) => {
          const { session } = await dispatch.start({
            sagaId,
            stationId: input.stationId,
            connectorId: input.connectorId,
            fleetId: input.fleetId,
            powerKw: context.powerKw,
            targetKwh: input.estimatedKwh,
          });
          return { sessionStatus: session.status };
        },
        compensation: {
          name: 'STOP_CHARGING',
          run: ({ sagaId, reason }) => dispatch.stop(sagaId, { reason, compensation: true }),
        },
      },
      {
        name: 'CONFIRM_RESERVATION',
        service: 'station-reservation-service',
        action: async ({ sagaId }) => {
          await station.confirm(sagaId);
          return {};
        },
        compensation: null,
      },
    ],
  };
}
