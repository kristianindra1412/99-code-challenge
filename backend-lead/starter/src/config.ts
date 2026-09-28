import 'dotenv/config';

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl:
    env === 'test'
      ? process.env.DATABASE_URL_TEST ?? 'postgres://wallet:wallet@localhost:5439/wallet_test'
      : process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5439/wallet',
};
