import { Router } from 'express';
import { z } from 'zod';
import { recordWager } from '../services/wagerService';
import { positiveAmountSchema } from '../lib/validation';

export const wagersRouter = Router();

const wagerParamsSchema = z.object({
  walletId: z.string().uuid({ message: 'walletId must be a valid UUID' }),
});

const wagerBodySchema = z.object({
  amount: positiveAmountSchema,
});

/**
 * POST /wallets/:walletId/wagers
 *
 * Debits the wallet balance, accumulates turnover, and writes an append-only ledger entry.
 * Guarantees zero overdraft under concurrent wagers using pessimistic row locking.
 * Returns 200 OK with balance and accruedTurnover.
 */
wagersRouter.post('/:walletId/wagers', async (req, res, next) => {
  try {
    const params = wagerParamsSchema.parse(req.params);
    const body = wagerBodySchema.parse(req.body);

    const result = await recordWager({
      walletId: params.walletId,
      amount: body.amount,
    });

    res.status(200).json({
      walletId: result.walletId,
      balance: result.balance,
      accruedTurnover: result.accruedTurnover,
    });
  } catch (err) {
    next(err);
  }
});
