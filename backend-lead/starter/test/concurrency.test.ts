import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';
import { dec } from '../src/lib/money';
import { recordWager, handlePspCallback, requestWithdrawal } from '../src/services';
import { InsufficientFundsError } from '../src/lib/errors';

const app = createApp();

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Phase 4: Concurrency Engine & Race Condition Stress Suite (test/concurrency.test.ts)', () => {
  // Helper to create member + wallet
  async function createMemberWithWallet(username: string) {
    const res = await request(app).post('/members').send({ username });
    expect(res.status).toBe(201);
    return {
      memberId: res.body.member.id,
      walletId: res.body.wallet.id,
    };
  }

  // Helper to fund wallet via deposit + callback
  async function fundWallet(memberId: string, amount: string, turnoverMultiplier = 0) {
    const depRes = await request(app).post('/deposits').send({
      memberId,
      amount,
      turnoverMultiplier,
    });
    expect(depRes.status).toBe(201);

    const cbRes = await request(app).post('/psp/callbacks').send({
      pspRef: depRes.body.pspRef,
      status: 'completed',
      amount,
    });
    expect(cbRes.status).toBe(200);

    return { pspRef: depRes.body.pspRef, fundingTxId: depRes.body.id };
  }

  // Ledger audit helper
  async function auditWalletLedger(walletId: string) {
    const entries = await WalletTx.findAll({
      where: { walletId },
      order: [['createdAt', 'ASC']],
    });

    let running = dec('0');
    for (const entry of entries) {
      const amt = dec(entry.amount);
      if (entry.direction === 'credit') {
        running = running.plus(amt);
      } else if (entry.direction === 'debit') {
        running = running.minus(amt);
      }
      expect(dec(entry.balanceAfter).toFixed(18)).toBe(running.toFixed(18));
    }

    const wallet = await Wallet.findByPk(walletId);
    expect(wallet).not.toBeNull();
    expect(running.toFixed(18)).toBe(dec(wallet!.balance).toFixed(18));

    return {
      balance: running.toFixed(18),
      entryCount: entries.length,
      entries,
    };
  }

  describe('1. Concurrent Duplicate Callbacks (In-Flight Delivery Race)', () => {
    it('serializes 10 concurrent webhook requests via row-level locking with exactly 1 credit', async () => {
      const { memberId, walletId } = await createMemberWithWallet('race_callback_user');

      // Create a pending deposit of 100.00
      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '100.00',
        turnoverMultiplier: 1,
      });
      expect(depRes.status).toBe(201);
      const pspRef = depRes.body.pspRef;

      // Simulate 10 parallel webhook deliveries arriving at the exact same millisecond
      const concurrentRequests = Array.from({ length: 10 }, () =>
        request(app).post('/psp/callbacks').send({
          pspRef,
          status: 'completed',
          amount: '100.00',
        }),
      );

      const responses = await Promise.all(concurrentRequests);

      // All 10 requests must receive HTTP 200 OK from the server
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('completed');
      }

      // Exactly ONE request must have executed the state change; the other 9 must be marked idempotent
      const executed = responses.filter((r) => r.body.idempotent === false);
      const idempotent = responses.filter((r) => r.body.idempotent === true);

      expect(executed).toHaveLength(1);
      expect(idempotent).toHaveLength(9);

      // Wallet balance must be credited exactly ONCE ($100, never $1000)
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('100.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('100.000000000000000000');

      // Ledger has strictly 1 credit record
      const audit = await auditWalletLedger(walletId);
      expect(audit.entryCount).toBe(1);
      expect(audit.balance).toBe('100.000000000000000000');
    });
  });

  describe('2. Concurrent Wagers (Overdraw Prevention & Zero-Sum Invariant)', () => {
    it('prevents overdraw when 5 concurrent wagers of 30 compete for 100 balance', async () => {
      const { memberId, walletId } = await createMemberWithWallet('race_wager_user');

      // Fund wallet with 100.00
      await fundWallet(memberId, '100.00');

      // 5 concurrent wagers of 30.00 ($150 total requested against $100 balance)
      const wagerRequests = Array.from({ length: 5 }, () =>
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '30.00' }),
      );

      const responses = await Promise.all(wagerRequests);

      // Exactly 3 wagers must succeed (200 OK), exactly 2 must fail (422 Unprocessable Entity)
      const successful = responses.filter((r) => r.status === 200);
      const failed = responses.filter((r) => r.status === 422);

      expect(successful).toHaveLength(3);
      expect(failed).toHaveLength(2);

      for (const res of failed) {
        expect(res.body.error).toBe('insufficient_funds');
      }

      // Final wallet balance must be strictly 10.00 (100 - 90 = 10), never negative!
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('10.000000000000000000');
      expect(wallet!.accruedTurnover).toBe('90.000000000000000000');

      // Ledger audit: 1 deposit + 3 successful wagers = 4 entries
      const audit = await auditWalletLedger(walletId);
      expect(audit.entryCount).toBe(4);
      expect(audit.balance).toBe('10.000000000000000000');
    });
  });

  describe('3. High-Contention Stress Race: 20 Concurrent Wagers', () => {
    it('handles 20 concurrent wagers competing for exact balance exhaustion without balance corruption', async () => {
      const { memberId, walletId } = await createMemberWithWallet('stress_wager_user');

      // Fund wallet with 50.00
      await fundWallet(memberId, '50.00');

      // 20 concurrent wagers of 5.00 each ($100 total requested against $50 balance)
      const wagerRequests = Array.from({ length: 20 }, () =>
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '5.00' }),
      );

      const responses = await Promise.all(wagerRequests);

      // Exactly 10 wagers succeed ($50 spent), exactly 10 fail with 422
      const successful = responses.filter((r) => r.status === 200);
      const failed = responses.filter((r) => r.status === 422);

      expect(successful).toHaveLength(10);
      expect(failed).toHaveLength(10);

      for (const res of failed) {
        expect(res.body.error).toBe('insufficient_funds');
      }

      // Final wallet balance must be strictly 0.000000000000000000
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('0.000000000000000000');
      expect(wallet!.accruedTurnover).toBe('50.000000000000000000');

      // Ledger audit: 1 deposit + 10 wagers = 11 entries
      const audit = await auditWalletLedger(walletId);
      expect(audit.entryCount).toBe(11);
      expect(audit.balance).toBe('0.000000000000000000');
    });
  });

  describe('4. Concurrent Duplicate Withdrawals (Double-Escrow Debit Prevention)', () => {
    it('ensures only one withdrawal succeeds when two concurrent withdrawals exceed available funds', async () => {
      const { memberId, walletId } = await createMemberWithWallet('race_withdrawal_user');

      // Fund wallet with 60.00 with 0 required turnover
      await fundWallet(memberId, '60.00', 0);

      // Launch 2 concurrent withdrawals of 50.00 each ($100 total attempted against $60 balance)
      const withdrawalRequests = [
        request(app).post('/withdrawals').send({ memberId, amount: '50.00' }),
        request(app).post('/withdrawals').send({ memberId, amount: '50.00' }),
      ];

      const responses = await Promise.all(withdrawalRequests);

      // Exactly 1 must succeed (201 Created), exactly 1 must fail (422 Insufficient Funds)
      const successful = responses.filter((r) => r.status === 201);
      const failed = responses.filter((r) => r.status === 422);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(1);

      expect(failed[0].body.error).toBe('insufficient_funds');

      // Wallet balance must end at exactly 10.00 (60 - 50 = 10), never -40!
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('10.000000000000000000');

      // Exactly 1 pending withdrawal funding transaction created
      const pendingWithdrawals = await FundingTransaction.findAll({
        where: { memberId, type: 'withdrawal' },
      });
      expect(pendingWithdrawals).toHaveLength(1);
      expect(pendingWithdrawals[0].status).toBe('pending');
      expect(pendingWithdrawals[0].amount).toBe('50.000000000000000000');

      // Ledger audit: 1 deposit + 1 withdrawal = 2 entries
      const audit = await auditWalletLedger(walletId);
      expect(audit.entryCount).toBe(2);
      expect(audit.balance).toBe('10.000000000000000000');
    });
  });

  describe('5. Interleaved Operations Race: Callback + Concurrent Wagers + Withdrawal', () => {
    it('safely serializes mixed concurrent operations on the same wallet without corruption or deadlocks', async () => {
      const { memberId, walletId } = await createMemberWithWallet('interleaved_stress_user');

      // Start with 50.00 funded
      await fundWallet(memberId, '50.00', 0);

      // Create an in-flight pending deposit of 100.00 (turnover multiplier 0)
      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '100.00',
        turnoverMultiplier: 0,
      });
      const pspRef = depRes.body.pspRef;

      // Simultaneously fire:
      // - 1 PSP callback completing the 100.00 deposit
      // - 4 concurrent wagers of 35.00 each ($140 total attempted)
      // - 1 withdrawal of 40.00
      const mixedRequests = [
        request(app).post('/psp/callbacks').send({ pspRef, status: 'completed', amount: '100.00' }),
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '35.00' }),
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '35.00' }),
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '35.00' }),
        request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '35.00' }),
        request(app).post('/withdrawals').send({ memberId, amount: '40.00' }),
      ];

      const responses = await Promise.all(mixedRequests);

      // Verify that no request errored with internal server error (500)
      for (const res of responses) {
        expect(res.status).not.toBe(500);
      }

      // PSP callback must succeed
      const cbRes = responses[0];
      expect(cbRes.status).toBe(200);

      // Wallet balance must be non-negative
      const wallet = await Wallet.findByPk(walletId);
      expect(dec(wallet!.balance).isGreaterThanOrEqualTo(0)).toBe(true);

      // Audit reconstructibility: Computed ledger balance must strictly match DB balance
      const audit = await auditWalletLedger(walletId);
      expect(audit.balance).toBe(dec(wallet!.balance).toFixed(18));
    });
  });

  describe('6. Direct Domain Services Concurrency Engine', () => {
    it('enforces row lock serialization directly on service layer methods', async () => {
      const { memberId, walletId } = await createMemberWithWallet('direct_service_concurrency');

      // Fund wallet with 100.00
      await fundWallet(memberId, '100.00', 0);

      // Fire 6 concurrent service calls of 20.00 each ($120 requested against $100 balance)
      const servicePromises = Array.from({ length: 6 }, () =>
        recordWager({ walletId, amount: '20.00' }),
      );

      const settled = await Promise.allSettled(servicePromises);

      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');

      // Exactly 5 succeed ($100 spent), 1 rejected with InsufficientFundsError
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientFundsError);

      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('0.000000000000000000');

      const audit = await auditWalletLedger(walletId);
      expect(audit.balance).toBe('0.000000000000000000');
      expect(audit.entryCount).toBe(6); // 1 deposit + 5 wagers
    });
  });
});
