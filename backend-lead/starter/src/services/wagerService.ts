import { sequelize } from '../db/sequelize';
import { Wallet, WalletTx } from '../db/models';
import { dec } from '../lib/money';
import { InsufficientFundsError, NotFoundError, ValidationError } from '../lib/errors';

export interface RecordWagerParams {
  walletId: string;
  amount: string;
}

export interface WagerResult {
  walletId: string;
  balance: string;
  accruedTurnover: string;
}

/**
 * Records a real-time wager against a player's wallet.
 *
 * Concurrency & Invariants:
 * 1. Pessimistic Row Locking: SELECT ... FOR UPDATE on the wallet prevents race conditions
 *    and overdrawing when concurrent wagers arrive simultaneously.
 * 2. Balance Verification: Rejects immediately if balance < wager amount with InsufficientFundsError.
 * 3. Turnover Tracking: Advances accruedTurnover by the wager amount.
 * 4. Immutable Ledger: Appends a debit record to wallet_txs with snapshot balance_after.
 * 5. DB Constraint: chk_wallets_balance_non_negative guarantees defense-in-depth against negative balances.
 */
export async function recordWager(params: RecordWagerParams): Promise<WagerResult> {
  if (!params.walletId) {
    throw new ValidationError('walletId is required');
  }

  const bnAmount = dec(params.amount);
  if (bnAmount.isLessThanOrEqualTo(0)) {
    throw new ValidationError('Wager amount must be positive');
  }

  return sequelize.transaction(async (t) => {
    // 1. Lock wallet row with pessimistic lock
    const wallet = await Wallet.findByPk(params.walletId, {
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!wallet) {
      throw new NotFoundError(`Wallet not found: ${params.walletId}`);
    }

    // 2. Validate sufficient funds
    const currentBalance = dec(wallet.balance);
    if (currentBalance.isLessThan(bnAmount)) {
      throw new InsufficientFundsError('Insufficient funds for wager');
    }

    // 3. Calculate new balance and turnover
    const newBalance = currentBalance.minus(bnAmount).toFixed(18);
    const newAccruedTurnover = dec(wallet.accruedTurnover).plus(bnAmount).toFixed(18);

    wallet.balance = newBalance;
    wallet.accruedTurnover = newAccruedTurnover;
    await wallet.save({ transaction: t });

    // 4. Create immutable debit ledger record
    await WalletTx.create(
      {
        walletId: wallet.id,
        fundingTxId: null,
        type: 'wager',
        amount: bnAmount.toFixed(18),
        direction: 'debit',
        balanceAfter: newBalance,
      },
      { transaction: t },
    );

    return {
      walletId: wallet.id,
      balance: newBalance,
      accruedTurnover: newAccruedTurnover,
    };
  });
}
