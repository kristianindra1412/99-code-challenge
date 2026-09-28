import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';
import {
  createMember,
  createDeposit,
  handlePspCallback,
  recordWager,
  requestWithdrawal,
} from '../src/services';
import {
  NotFoundError,
  InsufficientFundsError,
  TurnoverRequirementError,
  ValidationError,
} from '../src/lib/errors';
import { dec } from '../src/lib/money';

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Phase 2: Domain Services & Concurrency Engine', () => {
  describe('createDeposit Service', () => {
    it('creates a pending funding transaction with valid parameters', async () => {
      const { member } = await createMember('alice_dep');

      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '150.75',
        turnoverMultiplier: 2,
      });

      expect(fundingTx.id).toBeDefined();
      expect(fundingTx.memberId).toBe(member.id);
      expect(fundingTx.type).toBe('deposit');
      expect(fundingTx.status).toBe('pending');
      expect(fundingTx.amount).toBe('150.750000000000000000');
      expect(fundingTx.turnoverMultiplier).toBe(2);
      expect(fundingTx.pspRef).toMatch(/^psp_dep_/);
      expect(fundingTx.failureReason).toBeNull();
    });

    it('defaults turnoverMultiplier to 1 when omitted', async () => {
      const { member } = await createMember('alice_def');

      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '50.00',
      });

      expect(fundingTx.turnoverMultiplier).toBe(1);
    });

    it('throws NotFoundError if memberId does not exist', async () => {
      await expect(
        createDeposit({
          memberId: '00000000-0000-0000-0000-000000000000',
          amount: '100',
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ValidationError for zero or negative deposit amounts', async () => {
      const { member } = await createMember('alice_neg');

      await expect(
        createDeposit({
          memberId: member.id,
          amount: '0',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        createDeposit({
          memberId: member.id,
          amount: '-25.50',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for negative or non-integer turnoverMultiplier', async () => {
      const { member } = await createMember('alice_mult');

      await expect(
        createDeposit({
          memberId: member.id,
          amount: '100',
          turnoverMultiplier: -1,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        createDeposit({
          memberId: member.id,
          amount: '100',
          turnoverMultiplier: 1.5,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('handlePspCallback Service', () => {
    it('credits wallet, accrues required turnover, and writes ledger on completed deposit callback', async () => {
      const { member, wallet } = await createMember('bob_cb_ok');
      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '100.50',
        turnoverMultiplier: 2,
      });

      const result = await handlePspCallback({
        pspRef: fundingTx.pspRef,
        status: 'completed',
        amount: '100.50',
      });

      expect(result.status).toBe('completed');
      expect(result.idempotent).toBe(false);

      // Verify wallet balance & required turnover
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet).not.toBeNull();
      expect(updatedWallet!.balance).toBe('100.500000000000000000');
      // Required turnover: 100.50 * 2 = 201.00
      expect(updatedWallet!.requiredTurnover).toBe('201.000000000000000000');
      expect(updatedWallet!.accruedTurnover).toBe('0.000000000000000000');

      // Verify funding transaction updated to completed
      const updatedFundingTx = await FundingTransaction.findByPk(fundingTx.id);
      expect(updatedFundingTx!.status).toBe('completed');

      // Verify immutable ledger record in wallet_txs
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0].fundingTxId).toBe(fundingTx.id);
      expect(ledgerEntries[0].type).toBe('deposit');
      expect(ledgerEntries[0].direction).toBe('credit');
      expect(ledgerEntries[0].amount).toBe('100.500000000000000000');
      expect(ledgerEntries[0].balanceAfter).toBe('100.500000000000000000');
    });

    it('handles duplicate callback sequentially without double-crediting (idempotency guard)', async () => {
      const { member, wallet } = await createMember('bob_dup_seq');
      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '100.00',
        turnoverMultiplier: 1,
      });

      // First callback
      const firstResult = await handlePspCallback({
        pspRef: fundingTx.pspRef,
        status: 'completed',
        amount: '100.00',
      });
      expect(firstResult.status).toBe('completed');
      expect(firstResult.idempotent).toBe(false);

      // Second identical callback (duplicate delivery)
      const secondResult = await handlePspCallback({
        pspRef: fundingTx.pspRef,
        status: 'completed',
        amount: '100.00',
      });
      expect(secondResult.status).toBe('completed');
      expect(secondResult.idempotent).toBe(true);

      // Wallet balance must still be exactly 100 (never double credited!)
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('100.000000000000000000');
      expect(updatedWallet!.requiredTurnover).toBe('100.000000000000000000');

      // Exactly one ledger entry exists
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(1);
    });

    it('marks transaction failed and prevents balance credit on failed callback', async () => {
      const { member, wallet } = await createMember('bob_fail');
      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '50.00',
      });

      const result = await handlePspCallback({
        pspRef: fundingTx.pspRef,
        status: 'failed',
        amount: '50.00',
      });

      expect(result.status).toBe('failed');
      expect(result.idempotent).toBe(false);
      expect(result.reason).toBe('psp_declined');

      const updatedFundingTx = await FundingTransaction.findByPk(fundingTx.id);
      expect(updatedFundingTx!.status).toBe('failed');
      expect(updatedFundingTx!.failureReason).toBe('psp_declined');

      // Wallet balance remains 0
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('0.000000000000000000');

      // No ledger entry created
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(0);
    });

    it('enforces amount mismatch policy by marking transaction failed without crediting', async () => {
      const { member, wallet } = await createMember('bob_mismatch');
      const fundingTx = await createDeposit({
        memberId: member.id,
        amount: '100.00',
      });

      // PSP reported 90.00 instead of 100.00
      const result = await handlePspCallback({
        pspRef: fundingTx.pspRef,
        status: 'completed',
        amount: '90.00',
      });

      expect(result.status).toBe('failed');
      expect(result.idempotent).toBe(false);
      expect(result.reason).toBe('amount_mismatch');

      const updatedFundingTx = await FundingTransaction.findByPk(fundingTx.id);
      expect(updatedFundingTx!.status).toBe('failed');
      expect(updatedFundingTx!.failureReason).toBe('amount_mismatch');

      // Wallet balance remains unchanged
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('0.000000000000000000');

      // No ledger entry created
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(0);
    });

    it('throws NotFoundError for unknown pspRef', async () => {
      await expect(
        handlePspCallback({
          pspRef: 'psp_unknown_ref_123',
          status: 'completed',
          amount: '100',
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('recordWager Service', () => {
    it('debits wallet, accrues turnover, and writes ledger record', async () => {
      const { member, wallet } = await createMember('carol_wager');

      // Fund the wallet via deposit & callback
      const deposit = await createDeposit({ memberId: member.id, amount: '100' });
      await handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100' });

      // Place a wager of 25
      const wagerResult = await recordWager({
        walletId: wallet.id,
        amount: '25.00',
      });

      expect(wagerResult.walletId).toBe(wallet.id);
      expect(wagerResult.balance).toBe('75.000000000000000000');
      expect(wagerResult.accruedTurnover).toBe('25.000000000000000000');

      // Verify wallet row in DB
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('75.000000000000000000');
      expect(updatedWallet!.accruedTurnover).toBe('25.000000000000000000');

      // Verify ledger entries: 1 deposit credit, 1 wager debit
      const ledgerEntries = await WalletTx.findAll({
        where: { walletId: wallet.id },
        order: [['createdAt', 'ASC']],
      });
      expect(ledgerEntries).toHaveLength(2);

      const wagerLedger = ledgerEntries[1];
      expect(wagerLedger.type).toBe('wager');
      expect(wagerLedger.direction).toBe('debit');
      expect(wagerLedger.amount).toBe('25.000000000000000000');
      expect(wagerLedger.balanceAfter).toBe('75.000000000000000000');
      expect(wagerLedger.fundingTxId).toBeNull();
    });

    it('rejects wager when wallet has insufficient funds', async () => {
      const { member, wallet } = await createMember('carol_insufficient');

      const deposit = await createDeposit({ memberId: member.id, amount: '20' });
      await handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '20' });

      await expect(
        recordWager({
          walletId: wallet.id,
          amount: '20.000000000000000001',
        }),
      ).rejects.toThrow(InsufficientFundsError);

      // Balance remains 20
      const currentWallet = await Wallet.findByPk(wallet.id);
      expect(currentWallet!.balance).toBe('20.000000000000000000');
      expect(currentWallet!.accruedTurnover).toBe('0.000000000000000000');
    });

    it('throws ValidationError for zero or negative wager amount', async () => {
      const { wallet } = await createMember('carol_neg_wager');

      await expect(recordWager({ walletId: wallet.id, amount: '0' })).rejects.toThrow(ValidationError);
      await expect(recordWager({ walletId: wallet.id, amount: '-5' })).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError for non-existent walletId', async () => {
      await expect(
        recordWager({
          walletId: '00000000-0000-0000-0000-000000000000',
          amount: '10',
        }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('requestWithdrawal Service', () => {
    it('blocks withdrawal when accrued turnover is less than required turnover', async () => {
      const { member } = await createMember('dan_turnover_lock');

      // Deposit 100 with multiplier 2 (required turnover = 200)
      const dep = await createDeposit({ memberId: member.id, amount: '100', turnoverMultiplier: 2 });
      await handlePspCallback({ pspRef: dep.pspRef, status: 'completed', amount: '100' });

      // Attempt withdrawal without any wagers (accrued: 0, required: 200, outstanding: 200)
      try {
        await requestWithdrawal({ memberId: member.id, amount: '50' });
        fail('Expected TurnoverRequirementError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TurnoverRequirementError);
        const turnoverErr = err as TurnoverRequirementError;
        expect(turnoverErr.requiredTurnover).toBe('200.000000000000000000');
        expect(turnoverErr.accruedTurnover).toBe('0.000000000000000000');
        expect(turnoverErr.outstandingTurnover).toBe('200.000000000000000000');
      }

      // No withdrawal funding transaction created
      const fundingTxs = await FundingTransaction.findAll({
        where: { memberId: member.id, type: 'withdrawal' },
      });
      expect(fundingTxs).toHaveLength(0);
    });

    it('blocks withdrawal when turnover is partially satisfied', async () => {
      const { member, wallet } = await createMember('dan_partial_turnover');

      // Deposit 100 with multiplier 2 (required turnover = 200)
      const dep = await createDeposit({ memberId: member.id, amount: '100', turnoverMultiplier: 2 });
      await handlePspCallback({ pspRef: dep.pspRef, status: 'completed', amount: '100' });

      // Wager 60 (balance becomes 40, accrued turnover becomes 60, outstanding: 140)
      await recordWager({ walletId: wallet.id, amount: '60' });

      // Attempt withdrawal of remaining 40
      try {
        await requestWithdrawal({ memberId: member.id, amount: '40' });
        fail('Expected TurnoverRequirementError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(TurnoverRequirementError);
        const turnoverErr = err as TurnoverRequirementError;
        expect(turnoverErr.requiredTurnover).toBe('200.000000000000000000');
        expect(turnoverErr.accruedTurnover).toBe('60.000000000000000000');
        expect(turnoverErr.outstandingTurnover).toBe('140.000000000000000000');
      }
    });

    it('blocks withdrawal when turnover is met but wallet balance is insufficient', async () => {
      const { member, wallet } = await createMember('dan_insufficient_bal');

      // Deposit 100 with multiplier 1 (required: 100)
      const dep = await createDeposit({ memberId: member.id, amount: '100', turnoverMultiplier: 1 });
      await handlePspCallback({ pspRef: dep.pspRef, status: 'completed', amount: '100' });

      // Wager 100 (accrued: 100 >= required: 100, remaining balance: 0)
      await recordWager({ walletId: wallet.id, amount: '100' });

      await expect(
        requestWithdrawal({ memberId: member.id, amount: '10' }),
      ).rejects.toThrow(InsufficientFundsError);
    });

    it('allows withdrawal when turnover is fully satisfied and balance is sufficient', async () => {
      const { member, wallet } = await createMember('dan_success_wdr');

      // Deposit 100 with multiplier 1
      const dep = await createDeposit({ memberId: member.id, amount: '100', turnoverMultiplier: 1 });
      await handlePspCallback({ pspRef: dep.pspRef, status: 'completed', amount: '100' });

      // Wager 100 (accrued: 100 >= required: 100)
      await recordWager({ walletId: wallet.id, amount: '100' });

      // Deposit another 50 with multiplier 0 (e.g. promotional reload without turnover)
      const dep2 = await createDeposit({ memberId: member.id, amount: '50', turnoverMultiplier: 0 });
      await handlePspCallback({ pspRef: dep2.pspRef, status: 'completed', amount: '50' });

      // Request withdrawal of 30
      const withdrawal = await requestWithdrawal({ memberId: member.id, amount: '30' });

      expect(withdrawal.id).toBeDefined();
      expect(withdrawal.memberId).toBe(member.id);
      expect(withdrawal.amount).toBe('30.000000000000000000');
      expect(withdrawal.balance).toBe('20.000000000000000000');
      expect(withdrawal.status).toBe('pending');
      expect(withdrawal.pspRef).toMatch(/^psp_wdr_/);

      // Verify wallet balance debited immediately in escrow
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('20.000000000000000000');

      // Verify funding transaction created
      const wdrTx = await FundingTransaction.findByPk(withdrawal.id);
      expect(wdrTx!.type).toBe('withdrawal');
      expect(wdrTx!.status).toBe('pending');
      expect(wdrTx!.amount).toBe('30.000000000000000000');

      // Verify ledger debit entry
      const ledgerEntry = await WalletTx.findOne({
        where: { fundingTxId: withdrawal.id },
      });
      expect(ledgerEntry).not.toBeNull();
      expect(ledgerEntry!.type).toBe('withdrawal');
      expect(ledgerEntry!.direction).toBe('debit');
      expect(ledgerEntry!.amount).toBe('30.000000000000000000');
      expect(ledgerEntry!.balanceAfter).toBe('20.000000000000000000');
    });
  });

  describe('Full Financial Lifecycle & Ledger Reconstructibility', () => {
    it('accurately reconstructs wallet balance from ledger sum across a complex transaction lifecycle', async () => {
      const { member, wallet } = await createMember('audit_player');

      // 1. Initial Deposit: 200 (Multiplier 1) -> Balance 200, Req Turnover 200
      const dep1 = await createDeposit({ memberId: member.id, amount: '200', turnoverMultiplier: 1 });
      await handlePspCallback({ pspRef: dep1.pspRef, status: 'completed', amount: '200' });

      // 2. Wager 1: 50 -> Balance 150, Accrued Turnover 50
      await recordWager({ walletId: wallet.id, amount: '50' });

      // 3. Wager 2: 75 -> Balance 75, Accrued Turnover 125
      await recordWager({ walletId: wallet.id, amount: '75' });

      // 4. Second Deposit: 100 (Multiplier 1) -> Balance 175, Req Turnover 300
      const dep2 = await createDeposit({ memberId: member.id, amount: '100', turnoverMultiplier: 1 });
      await handlePspCallback({ pspRef: dep2.pspRef, status: 'completed', amount: '100' });

      // 5. Wager 3: 175 -> Balance 0, Accrued Turnover 300 (Turnover 300 >= 300 met!)
      await recordWager({ walletId: wallet.id, amount: '175' });

      // 6. Third Deposit: 250 (Multiplier 0) -> Balance 250, Req Turnover 300
      const dep3 = await createDeposit({ memberId: member.id, amount: '250', turnoverMultiplier: 0 });
      await handlePspCallback({ pspRef: dep3.pspRef, status: 'completed', amount: '250' });

      // 7. Withdrawal: 80 -> Balance 170
      await requestWithdrawal({ memberId: member.id, amount: '80' });

      // 8. Wager 4: 20 -> Balance 150
      await recordWager({ walletId: wallet.id, amount: '20' });

      // Retrieve final wallet state from database
      const finalWallet = await Wallet.findByPk(wallet.id);
      expect(finalWallet).not.toBeNull();
      const dbBalance = dec(finalWallet!.balance);

      // Audit Reconstructibility: Sum all credits and subtract all debits from wallet_txs
      const allTxRecords = await WalletTx.findAll({
        where: { walletId: wallet.id },
        order: [['createdAt', 'ASC']],
      });

      expect(allTxRecords).toHaveLength(8);

      let computedBalance = dec('0');
      for (const entry of allTxRecords) {
        const amt = dec(entry.amount);
        if (entry.direction === 'credit') {
          computedBalance = computedBalance.plus(amt);
        } else if (entry.direction === 'debit') {
          computedBalance = computedBalance.minus(amt);
        }
      }

      // Assert that computed balance strictly equals database balance
      expect(computedBalance.toFixed(18)).toBe(dbBalance.toFixed(18));
      expect(computedBalance.toFixed(18)).toBe('150.000000000000000000');
    });
  });

  describe('Concurrency & Race Condition Resilience (Service Level)', () => {
    it('handles concurrent duplicate callbacks in-flight without double-crediting', async () => {
      const { member, wallet } = await createMember('race_cb_player');
      const deposit = await createDeposit({
        memberId: member.id,
        amount: '100.00',
        turnoverMultiplier: 1,
      });

      // Fire 5 concurrent webhook deliveries simultaneously
      const results = await Promise.all([
        handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' }),
        handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' }),
        handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' }),
        handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' }),
        handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' }),
      ]);

      // Exactly one execution applied the credit; all others were idempotent
      const nonIdempotentCount = results.filter((r) => !r.idempotent).length;
      const idempotentCount = results.filter((r) => r.idempotent).length;

      expect(nonIdempotentCount).toBe(1);
      expect(idempotentCount).toBe(4);

      // Wallet balance must be credited exactly once
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('100.000000000000000000');
      expect(updatedWallet!.requiredTurnover).toBe('100.000000000000000000');

      // Exactly 1 ledger entry created
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(1);
    });

    it('prevents overdraw under concurrent wagers using row-level pessimistic locking', async () => {
      const { member, wallet } = await createMember('race_wager_player');

      // Fund wallet with 100
      const deposit = await createDeposit({ memberId: member.id, amount: '100.00' });
      await handlePspCallback({ pspRef: deposit.pspRef, status: 'completed', amount: '100.00' });

      // Fire 5 concurrent wagers of 30 simultaneously (total attempted = 150 > 100 available)
      const wagerPromises = [
        recordWager({ walletId: wallet.id, amount: '30.00' }),
        recordWager({ walletId: wallet.id, amount: '30.00' }),
        recordWager({ walletId: wallet.id, amount: '30.00' }),
        recordWager({ walletId: wallet.id, amount: '30.00' }),
        recordWager({ walletId: wallet.id, amount: '30.00' }),
      ];

      const settlements = await Promise.allSettled(wagerPromises);

      const fulfilled = settlements.filter((s) => s.status === 'fulfilled');
      const rejected = settlements.filter((s) => s.status === 'rejected');

      // Exactly 3 wagers must succeed (3 * 30 = 90); 2 must be rejected with InsufficientFundsError
      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(2);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);
      }

      // Wallet balance must end at exactly 10.00 (100 - 90), never negative!
      const finalWallet = await Wallet.findByPk(wallet.id);
      expect(finalWallet!.balance).toBe('10.000000000000000000');
      expect(finalWallet!.accruedTurnover).toBe('90.000000000000000000');

      // Exactly 4 ledger entries: 1 deposit + 3 wagers
      const ledgerEntries = await WalletTx.findAll({ where: { walletId: wallet.id } });
      expect(ledgerEntries).toHaveLength(4);
    });
  });
});
