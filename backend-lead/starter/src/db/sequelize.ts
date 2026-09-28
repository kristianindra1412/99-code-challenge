import { Sequelize } from 'sequelize';
import { config } from '../config';

export const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: false,
  define: { underscored: true },
  pool: {
    max: 25,
    min: 2,
    idle: 10000,
    acquire: 30000,
  },
});
