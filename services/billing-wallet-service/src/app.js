// =============================================================================
// billing-wallet-service :: API HTTP interna
//
//   GET  /wallets                     Billeteras de las flotas
//   GET  /wallets/:fleetId            Saldo + movimientos de una flota
//   POST /wallets/:fleetId/topup      Recarga de saldo
//   POST /quotes                      Cotizacion (aplica tarifa dinamica)
//   POST /charges                     SAGA paso 2: cobro del saldo estimado
//   POST /charges/:sagaId/refund      COMPENSACION: reembolso + evento de reversion
// =============================================================================
import {
  createBaseApp,
  createServiceContext,
  installErrorHandlers,
  addToContext,
  currentContext,
  badRequest,
  notFound,
  requireFields,
  FLAGS,
  DomainError,
} from '@aegisvolt/common';
import { createBillingRepository } from './repository.js';
import { calculateQuote, parsePeakHours } from './pricing.js';

export const SERVICE_NAME = 'billing-wallet-service';

export function buildApp(overrides = {}) {
  const ctx = createServiceContext(SERVICE_NAME, overrides);
  const { config, logger, metrics, dynamo, flags } = ctx;
  const repository = overrides.repository ?? createBillingRepository({ dynamo, tableName: config.tables.billing });
  const peakHours = parsePeakHours(process.env.PEAK_HOURS ?? '0-23');

  // La cotizacion depende de las flags del AMBIENTE en que corre el servicio.
  async function quoteFor({ estimatedKwh, fastCharge }) {
    const kwh = Number(estimatedKwh);
    if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 500) {
      throw badRequest('VALIDATION_ERROR', 'estimatedKwh debe estar entre 0 y 500');
    }
    if (fastCharge && !(await flags.isEnabled(FLAGS.FAST_CHARGE_BOOST))) {
      throw new DomainError(
        'FAST_CHARGE_DISABLED',
        `La ultra-carga prioritaria no esta habilitada en el ambiente ${config.environment}`,
        { status: 409 },
      );
    }
    const surgePricingEnabled = await flags.isEnabled(FLAGS.DYNAMIC_SURGE_PRICING);
    return calculateQuote({ estimatedKwh: kwh, fastCharge: fastCharge === true, surgePricingEnabled, peakHours });
  }

  const app = createBaseApp({ config, logger, metrics });

  app.get('/wallets', async (_req, res) => {
    res.json({ wallets: await repository.listWallets() });
  });

  app.get('/wallets/:fleetId', async (req, res) => {
    const wallet = await repository.getWallet(req.params.fleetId);
    if (!wallet) throw notFound('WALLET_NOT_FOUND', `No existe billetera para la flota ${req.params.fleetId}`);
    res.json({ wallet, transactions: await repository.listTransactions(req.params.fleetId) });
  });

  app.post('/wallets/:fleetId/topup', async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw badRequest('VALIDATION_ERROR', 'amount debe ser un entero mayor que cero');
    }
    const wallet = await repository.topUp(req.params.fleetId, amount);
    logger.info('Billetera recargada', { fleet_id: req.params.fleetId, amount });
    res.json({ wallet });
  });

  app.post('/quotes', async (req, res) => {
    requireFields(req.body, ['estimatedKwh']);
    res.json({ quote: await quoteFor(req.body) });
  });

  app.post('/charges', async (req, res) => {
    requireFields(req.body, ['sagaId', 'fleetId', 'estimatedKwh']);
    const { sagaId, fleetId, estimatedKwh, fastCharge } = req.body;
    addToContext({ sagaId });

    const quote = await quoteFor({ estimatedKwh, fastCharge });
    const result = await repository.charge({
      sagaId,
      fleetId,
      amount: quote.total,
      quote,
      correlationId: currentContext().correlationId,
    });
    logger.info('Saldo descontado', {
      saga_step: 'CHARGE_WALLET',
      fleet_id: fleetId,
      amount: result.transaction.amount,
      surge_applied: quote.surgeApplied,
      balance_after: result.wallet.balance,
      idempotent_replay: result.idempotentReplay,
    });
    res.status(result.idempotentReplay ? 200 : 201).json(result);
  });

  app.post('/charges/:sagaId/refund', async (req, res) => {
    requireFields(req.body, ['fleetId']);
    const { sagaId } = req.params;
    addToContext({ sagaId });

    const result = await repository.refund({
      sagaId,
      fleetId: req.body.fleetId,
      reason: req.body.reason ?? 'SAGA_COMPENSATION',
      correlationId: currentContext().correlationId,
    });
    logger.info('COMPENSACION: reembolso a la billetera', {
      saga_step: 'REFUND_WALLET',
      compensation: true,
      fleet_id: req.body.fleetId,
      refunded: result.refunded,
      already_refunded: result.alreadyRefunded,
      nothing_to_refund: result.nothingToRefund,
      amount: result.transaction?.amount ?? 0,
      balance_after: result.wallet?.balance ?? null,
    });
    res.json(result);
  });

  installErrorHandlers(app, { logger });
  return { app, repository, ...ctx };
}
