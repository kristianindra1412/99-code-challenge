import { DataTypes, Model, Sequelize } from 'sequelize';

export type FundingTransactionType = 'deposit' | 'withdrawal';
export type FundingTransactionStatus = 'pending' | 'completed' | 'failed';

export class FundingTransaction extends Model {
  declare id: string;
  declare memberId: string;
  declare type: FundingTransactionType;
  // DECIMAL comes back from the pg driver as a string. Keep it that way; see src/lib/money.ts.
  declare amount: string;
  declare status: FundingTransactionStatus;
  declare pspRef: string;
  declare turnoverMultiplier: number;
  declare failureReason: string | null;
  declare readonly createdAt: Date;
  declare readonly updatedAt: Date;
}

export function initFundingTransaction(sequelize: Sequelize): void {
  FundingTransaction.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      memberId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING(32), allowNull: false },
      amount: { type: DataTypes.DECIMAL(36, 18), allowNull: false },
      status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
      pspRef: { type: DataTypes.STRING(128), allowNull: false, unique: true },
      turnoverMultiplier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      failureReason: { type: DataTypes.TEXT, allowNull: true },
    },
    { sequelize, tableName: 'funding_transactions', underscored: true },
  );
}
