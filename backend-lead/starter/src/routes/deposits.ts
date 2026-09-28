import { Router } from 'express';
import { z } from 'zod';
import { createDeposit } from '../services/depositService';
import { positiveAmountSchema } from '../lib/validation';

export const depositsRouter = Router();

const createDepositBodySchema = z.object({
  memberId: z.string().uuid({ message: 'memberId must be a valid UUID' }),
  amount: positiveAmountSchema,
  turnoverMultiplier: z
    .number()
    .int({ message: 'turnoverMultiplier must be an integer' })
    .min(0, { message: 'turnoverMultiplier must be >= 0' })
    .optional()
    .default(1),
});

/**
 * POST /deposits
 *
 * Initiates a funding transaction in Pending state.
 * Returns 201 Created with transaction ID and opaque pspRef.
 */
depositsRouter.post('/', async (req, res, next) => {
  try {
    const body = createDepositBodySchema.parse(req.body);
    const fundingTx = await createDeposit({
      memberId: body.memberId,
      amount: body.amount,
      turnoverMultiplier: body.turnoverMultiplier,
    });

    res.status(201).json({
      id: fundingTx.id,
      memberId: fundingTx.memberId,
      type: fundingTx.type,
      amount: fundingTx.amount,
      status: fundingTx.status,
      pspRef: fundingTx.pspRef,
      turnoverMultiplier: fundingTx.turnoverMultiplier,
    });
  } catch (err) {
    next(err);
  }
});
