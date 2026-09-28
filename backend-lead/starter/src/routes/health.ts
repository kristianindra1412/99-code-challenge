import { Router } from 'express';
import { sequelize } from '../db/sequelize';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  await sequelize.authenticate();
  res.json({ status: 'ok' });
});
