import { randomUUID } from 'crypto';
import { sequelize } from '../db/sequelize';
import { FundingTransaction, FundingTransactionStatus, Wallet, WalletTx } from '../db/models';
import { dec } from '../lib/money';
import {
  InsufficientFundsError,
  NotFoundError,
  TurnoverRequirementError,
  ValidationError,
} from '../lib/errors';

export interface RequestWithdrawalParams {
  memberId: string;
  amount: string;
}

export interface WithdrawalResult {
  id: string;
  withdrawalId: string;
  memberId: string;
  amount: string;
  balance: string;
  pspRef: string;
  status: FundingTransactionStatus;
}

/**
 * Initiates a player withdrawal with turnover lock verification and immediate escrow debit.
 *
 * Invariants & Regulatory Safeguards:
 * 1. Anti-Abuse / AML Turnover Lock: Withdrawals are strictly rejected if accruedTurnover < requiredTurnover.
 *    If unmet, TurnoverRequirementError is thrown with outstanding turnover details for HTTP 422 mapping.
 * 2. Pessimistic Row Locking: Acquires SELECT ... FOR UPDATE on the wallet to serialize withdrawals against wagers.
 * 3. Immediate Escrow Debit: Deducts funds immediately upon withdrawal request into escrow (pending funding tx),
 *    preventing the player from double-spending or wagering those same funds while external approval/payout is in flight.
 * 4. Append-Only Ledger: Inserts debit record in wallet_txs tied to the funding transaction id.
 */
export async function requestWithdrawal(params: RequestWithdrawalParams): Promise<WithdrawalResult> {
  if (!params.memberId) {
    throw new ValidationError('memberId is required');
  }

  const bnAmount = dec(params.amount);
  if (bnAmount.isLessThanOrEqualTo(0)) {
    throw new ValidationError('Withdrawal amount must be positive');
  }

  return sequelize.transaction(async (t) => {
    // 1. Lock the member's wallet
    const wallet = await Wallet.findOne({
      where: { memberId: params.memberId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!wallet) {
      throw new NotFoundError(`Wallet not found for memberId: ${params.memberId}`);
    }

    // 2. Enforce Turnover Lock (Anti-Abuse Rule)
    const accruedTurnover = dec(wallet.accruedTurnover);
    const requiredTurnover = dec(wallet.requiredTurnover);

    if (accruedTurnover.isLessThan(requiredTurnover)) {
      const outstandingTurnover = requiredTurnover.minus(accruedTurnover).toFixed(18);
      throw new TurnoverRequirementError({
        requiredTurnover: requiredTurnover.toFixed(18),
        accruedTurnover: accruedTurnover.toFixed(18),
        outstandingTurnover,
      });
    }

    // 3. Verify sufficient wallet balance
    const currentBalance = dec(wallet.balance);
    if (currentBalance.isLessThan(bnAmount)) {
      throw new InsufficientFundsError('Insufficient funds for withdrawal');
    }

    // 4. Create pending funding transaction record
    const pspRef = `psp_wdr_${randomUUID()}`;
    const fundingTx = await FundingTransaction.create(
      {
        memberId: params.memberId,
        type: 'withdrawal',
        amount: bnAmount.toFixed(18),
        status: 'pending',
        pspRef,
        turnoverMultiplier: 0,
      },
      { transaction: t },
    );

    // 5. Escrow deduction: debit wallet balance immediately
    const newBalance = currentBalance.minus(bnAmount).toFixed(18);
    wallet.balance = newBalance;
    await wallet.save({ transaction: t });

    // 6. Append-only ledger debit record
    await WalletTx.create(
      {
        walletId: wallet.id,
        fundingTxId: fundingTx.id,
        type: 'withdrawal',
        amount: bnAmount.toFixed(18),
        direction: 'debit',
        balanceAfter: newBalance,
      },
      { transaction: t },
    );

    return {
      id: fundingTx.id,
      withdrawalId: fundingTx.id,
      memberId: params.memberId,
      amount: bnAmount.toFixed(18),
      balance: newBalance,
      pspRef,
      status: fundingTx.status,
    };
  });
}
