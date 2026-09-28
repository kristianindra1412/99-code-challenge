import { DataTypes, Model, Sequelize } from 'sequelize';

export type WalletTxType = 'deposit' | 'wager' | 'withdrawal';
export type WalletTxDirection = 'credit' | 'debit';

export class WalletTx extends Model {
  declare id: string;
  declare walletId: string;
  declare fundingTxId: string | null;
  declare type: WalletTxType;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare amount: string;
  declare direction: WalletTxDirection;
  declare balanceAfter: string;
  declare readonly createdAt: Date;
}

export function initWalletTx(sequelize: Sequelize): void {
  WalletTx.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      walletId: { type: DataTypes.UUID, allowNull: false },
      fundingTxId: { type: DataTypes.UUID, allowNull: true },
      type: { type: DataTypes.STRING(32), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      direction: { type: DataTypes.STRING(8), allowNull: false },
      balanceAfter: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
    },
    {
      sequelize,
      tableName: 'wallet_txs',
      underscored: true,
      timestamps: true,
      updatedAt: false,
    },
  );
}
