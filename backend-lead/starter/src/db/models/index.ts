import { sequelize } from '../sequelize';
import { Member, initMember } from './member';
import { Wallet, initWallet } from './wallet';
import { FundingTransaction, initFundingTransaction, FundingTransactionType, FundingTransactionStatus } from './fundingTransaction';
import { WalletTx, initWalletTx, WalletTxType, WalletTxDirection } from './walletTx';

initMember(sequelize);
initWallet(sequelize);
initFundingTransaction(sequelize);
initWalletTx(sequelize);

// Member <-> Wallet (1-to-1)
Member.hasOne(Wallet, { foreignKey: 'memberId', as: 'wallet' });
Wallet.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

// Member <-> FundingTransaction (1-to-many)
Member.hasMany(FundingTransaction, { foreignKey: 'memberId', as: 'fundingTransactions' });
FundingTransaction.belongsTo(Member, { foreignKey: 'memberId', as: 'member' });

// Wallet <-> WalletTx (1-to-many)
Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'transactions' });
Wallet.hasMany(WalletTx, { foreignKey: 'walletId', as: 'ledgerEntries' });
WalletTx.belongsTo(Wallet, { foreignKey: 'walletId', as: 'wallet' });

// FundingTransaction <-> WalletTx (1-to-1)
FundingTransaction.hasOne(WalletTx, { foreignKey: 'fundingTxId', as: 'ledgerEntry' });
WalletTx.belongsTo(FundingTransaction, { foreignKey: 'fundingTxId', as: 'fundingTransaction' });

export {
  Member,
  Wallet,
  FundingTransaction,
  WalletTx,
  FundingTransactionType,
  FundingTransactionStatus,
  WalletTxType,
  WalletTxDirection,
};
