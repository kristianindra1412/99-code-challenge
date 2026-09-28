import { sequelize } from '../db/sequelize';
import { FundingTransaction, Wallet, WalletTx, FundingTransactionStatus } from '../db/models';
import { dec } from '../lib/money';
import { NotFoundError, ValidationError } from '../lib/errors';

export interface HandlePspCallbackParams {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string;
}

export interface PspCallbackResult {
  status: FundingTransactionStatus;
  idempotent: boolean;
  reason?: string;
}

/**
 * Handles incoming webhook callbacks from payment service providers.
 *
 * Concurrency & Idempotency Guarantees:
 * 1. Pessimistic Locking: Acquires SELECT ... FOR UPDATE on funding_transactions by pspRef.
 *    Any concurrent callbacks for the same pspRef are serialized at the PostgreSQL row level.
 * 2. Idempotency Guard: If the transaction has already transitioned to a terminal state
 *    ('completed' or 'failed'), immediately returns without modifying wallet balances or ledger.
 * 3. Amount Mismatch Policy: If the callback amount does not strictly match the expected amount,
 *    the transaction is transitioned to 'failed' with reason 'amount_mismatch' to prevent tampering.
 * 4. Deterministic Lock Ordering: funding_transactions is locked first, then wallets,
 *    preventing database-level deadlocks across services.
 * 5. Append-Only Ledgering: Every balance change writes an immutable credit/debit record to wallet_txs.
 */
export async function handlePspCallback(params: HandlePspCallbackParams): Promise<PspCallbackResult> {
  if (!params.pspRef) {
    throw new ValidationError('pspRef is required');
  }

  if (params.status !== 'completed' && params.status !== 'failed') {
    throw new ValidationError('status must be completed or failed');
  }

  const callbackAmount = dec(params.amount);
  if (callbackAmount.isLessThanOrEqualTo(0)) {
    throw new ValidationError('Amount must be positive');
  }

  return sequelize.transaction(async (t) => {
    // 1. Acquire pessimistic lock on the funding transaction
    const fundingTx = await FundingTransaction.findOne({
      where: { pspRef: params.pspRef },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!fundingTx) {
      throw new NotFoundError(`Funding transaction not found for pspRef: ${params.pspRef}`);
    }

    // 2. Idempotency Guard: If already processed, acknowledge without re-applying side effects
    if (fundingTx.status !== 'pending') {
      return {
        status: fundingTx.status,
        idempotent: true,
        reason: fundingTx.failureReason ?? undefined,
      };
    }

    // 3. Amount Mismatch Policy: Discrepancies mark transaction as failed for security audit
    const expectedAmount = dec(fundingTx.amount);
    if (!callbackAmount.isEqualTo(expectedAmount)) {
      fundingTx.status = 'failed';
      fundingTx.failureReason = 'amount_mismatch';
      await fundingTx.save({ transaction: t });

      return {
        status: 'failed',
        idempotent: false,
        reason: 'amount_mismatch',
      };
    }

    // 4. Handle failed callback from PSP
    if (params.status === 'failed') {
      fundingTx.status = 'failed';
      fundingTx.failureReason = 'psp_declined';
      await fundingTx.save({ transaction: t });

      // If this was a withdrawal that failed externally, refund the debited balance
      if (fundingTx.type === 'withdrawal') {
        const wallet = await Wallet.findOne({
          where: { memberId: fundingTx.memberId },
          lock: t.LOCK.UPDATE,
          transaction: t,
        });

        if (wallet) {
          const refundAmount = dec(fundingTx.amount);
          const newBalance = dec(wallet.balance).plus(refundAmount).toFixed(18);
          wallet.balance = newBalance;
          await wallet.save({ transaction: t });

          await WalletTx.create(
            {
              walletId: wallet.id,
              fundingTxId: fundingTx.id,
              type: 'withdrawal',
              amount: refundAmount.toFixed(18),
              direction: 'credit',
              balanceAfter: newBalance,
            },
            { transaction: t },
          );
        }
      }

      return {
        status: 'failed',
        idempotent: false,
        reason: 'psp_declined',
      };
    }

    // 5. Handle completed callback from PSP
    if (fundingTx.type === 'deposit') {
      // Deterministic lock acquisition: Lock member wallet
      const wallet = await Wallet.findOne({
        where: { memberId: fundingTx.memberId },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });

      if (!wallet) {
        throw new NotFoundError(`Wallet not found for memberId: ${fundingTx.memberId}`);
      }

      const depositAmount = dec(fundingTx.amount);
      const currentBalance = dec(wallet.balance);
      const newBalance = currentBalance.plus(depositAmount).toFixed(18);

      const currentReqTurnover = dec(wallet.requiredTurnover);
      const turnoverMultiplier = fundingTx.turnoverMultiplier ?? 1;
      const additionalTurnover = depositAmount.times(turnoverMultiplier);
      const newRequiredTurnover = currentReqTurnover.plus(additionalTurnover).toFixed(18);

      wallet.balance = newBalance;
      wallet.requiredTurnover = newRequiredTurnover;
      await wallet.save({ transaction: t });

      // Write immutable ledger entry
      await WalletTx.create(
        {
          walletId: wallet.id,
          fundingTxId: fundingTx.id,
          type: 'deposit',
          amount: depositAmount.toFixed(18),
          direction: 'credit',
          balanceAfter: newBalance,
        },
        { transaction: t },
      );

      fundingTx.status = 'completed';
      await fundingTx.save({ transaction: t });

      return {
        status: 'completed',
        idempotent: false,
      };
    } else {
      // Withdrawal completion: funds were already escrowed/debited at request time
      fundingTx.status = 'completed';
      await fundingTx.save({ transaction: t });

      return {
        status: 'completed',
        idempotent: false,
      };
    }
  });
}
