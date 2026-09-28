import { Router } from 'express';
import { z } from 'zod';
import { requestWithdrawal } from '../services/withdrawalService';
import { positiveAmountSchema } from '../lib/validation';

export const withdrawalsRouter = Router();

const createWithdrawalBodySchema = z.object({
  memberId: z.string().uuid({ message: 'memberId must be a valid UUID' }),
  amount: positiveAmountSchema,
});

/**
 * POST /withdrawals
 *
 * Enforces AML/Anti-Abuse turnover lock (accruedTurnover >= requiredTurnover).
 * Debits the wallet immediately into escrow, creates a pending funding transaction,
 * and writes a ledger entry.
 * Returns 201 Created on success, or 422 if turnover is unmet or funds are insufficient.
 */
withdrawalsRouter.post('/', async (req, res, next) => {
  try {
    const body = createWithdrawalBodySchema.parse(req.body);
    const result = await requestWithdrawal({
      memberId: body.memberId,
      amount: body.amount,
    });

    res.status(201).json({
      id: result.id,
      withdrawalId: result.withdrawalId,
      memberId: result.memberId,
      amount: result.amount,
      balance: result.balance,
      pspRef: result.pspRef,
      status: result.status,
    });
  } catch (err) {
    next(err);
  }
});
