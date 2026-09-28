import { Router } from 'express';
import { z } from 'zod';
import { handlePspCallback } from '../services/pspCallbackService';
import { positiveAmountSchema } from '../lib/validation';

export const pspCallbacksRouter = Router();

const pspCallbackBodySchema = z.object({
  pspRef: z.string().min(1, { message: 'pspRef must not be empty' }),
  status: z.enum(['completed', 'failed'], {
    errorMap: () => ({ message: "status must be 'completed' or 'failed'" }),
  }),
  amount: positiveAmountSchema,
});

/**
 * POST /psp/callbacks
 *
 * Webhook receiver for PSP status updates (completed / failed).
 * Guarantees idempotent execution, row-level locking, and ledger consistency.
 * Returns 200 OK.
 */
pspCallbacksRouter.post('/', async (req, res, next) => {
  try {
    const body = pspCallbackBodySchema.parse(req.body);
    const result = await handlePspCallback({
      pspRef: body.pspRef,
      status: body.status,
      amount: body.amount,
    });

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
