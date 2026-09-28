import express, { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { healthRouter } from './routes/health';
import { membersRouter } from './routes/members';
import { depositsRouter } from './routes/deposits';
import { pspCallbacksRouter } from './routes/pspCallbacks';
import { wagersRouter } from './routes/wagers';
import { withdrawalsRouter } from './routes/withdrawals';
import {
  NotFoundError,
  InsufficientFundsError,
  TurnoverRequirementError,
  ValidationError,
} from './lib/errors';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', details: err.issues });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: 'validation_error', message: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: 'not_found', message: err.message });
    return;
  }
  if (err instanceof TurnoverRequirementError) {
    res.status(422).json({
      error: 'turnover_unmet',
      message: err.message,
      requiredTurnover: err.requiredTurnover,
      accruedTurnover: err.accruedTurnover,
      outstandingTurnover: err.outstandingTurnover,
    });
    return;
  }
  if (err instanceof InsufficientFundsError) {
    res.status(422).json({ error: 'insufficient_funds', message: err.message });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
};

export function createApp() {
  const app = express();
  app.use(express.json());

  app.use('/health', healthRouter);
  app.use('/members', membersRouter);
  app.use('/deposits', depositsRouter);
  app.use('/psp/callbacks', pspCallbacksRouter);
  app.use('/wallets', wagersRouter);
  app.use('/withdrawals', withdrawalsRouter);

  app.use(errorHandler);
  return app;
}
