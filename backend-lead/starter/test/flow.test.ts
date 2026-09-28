import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';
import { dec } from '../src/lib/money';

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

describe('Phase 4: Full Financial Lifecycle & End-to-End Business Flows (test/flow.test.ts)', () => {
  // Helper to create a test member and their wallet via POST /members
  async function createTestMember(username: string) {
    const res = await request(app).post('/members').send({ username });
    expect(res.status).toBe(201);
    return {
      memberId: res.body.member.id,
      walletId: res.body.wallet.id,
      username: res.body.member.username,
    };
  }

  // Helper to reconstruct wallet balance from the immutable append-only ledger
  async function auditLedgerBalance(walletId: string) {
    const entries = await WalletTx.findAll({
      where: { walletId },
      order: [['createdAt', 'ASC']],
    });

    let runningBalance = dec('0');
    for (const entry of entries) {
      const amt = dec(entry.amount);
      if (entry.direction === 'credit') {
        runningBalance = runningBalance.plus(amt);
      } else if (entry.direction === 'debit') {
        runningBalance = runningBalance.minus(amt);
      }
      // Verify point-in-time snapshot balance
      expect(dec(entry.balanceAfter).toFixed(18)).toBe(runningBalance.toFixed(18));
    }

    const wallet = await Wallet.findByPk(walletId);
    expect(wallet).not.toBeNull();
    expect(runningBalance.toFixed(18)).toBe(dec(wallet!.balance).toFixed(18));

    return {
      calculatedBalance: runningBalance.toFixed(18),
      dbBalance: dec(wallet!.balance).toFixed(18),
      entryCount: entries.length,
      entries,
    };
  }

  describe('1. Full End-to-End Lifecycle (Deposit -> Turnover Barrier -> Wagers -> Unlocked Withdrawal)', () => {
    it('executes the full financial lifecycle while enforcing turnover locks and ledger audits', async () => {
      const { memberId, walletId } = await createTestMember('alice_e2e');

      // 1. Initial Deposit Request
      // Alice deposits 100.00 with turnover multiplier = 2
      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '100.00',
        turnoverMultiplier: 2,
      });

      expect(depRes.status).toBe(201);
      expect(depRes.body.status).toBe('pending');
      expect(depRes.body.amount).toBe('100.000000000000000000');
      expect(depRes.body.turnoverMultiplier).toBe(2);
      expect(depRes.body.pspRef).toMatch(/^psp_dep_/);
      const pspRef = depRes.body.pspRef;

      // Invariant: No money in wallet before callback arrives
      let wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('0.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('0.000000000000000000');

      // 2. PSP Callback: Deposit Confirmed
      const cbRes = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '100.00',
      });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('completed');
      expect(cbRes.body.idempotent).toBe(false);

      // Verify wallet state: Balance = 100, Required Turnover = 100 * 2 = 200, Accrued = 0
      wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('100.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('200.000000000000000000');
      expect(wallet!.accruedTurnover).toBe('0.000000000000000000');

      // 3. Immediate Withdrawal Attempt (Must be BLOCKED by turnover lock)
      // Alice tries to cash out 50.00 immediately without playing
      const blockedWdrRes = await request(app).post('/withdrawals').send({
        memberId,
        amount: '50.00',
      });

      expect(blockedWdrRes.status).toBe(422);
      expect(blockedWdrRes.body.error).toBe('turnover_unmet');
      expect(blockedWdrRes.body.requiredTurnover).toBe('200.000000000000000000');
      expect(blockedWdrRes.body.accruedTurnover).toBe('0.000000000000000000');
      expect(blockedWdrRes.body.outstandingTurnover).toBe('200.000000000000000000');

      // Invariant: Wallet balance unchanged, no withdrawal funding tx created
      wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('100.000000000000000000');

      // 4. Partial Wager (Wager 60.00)
      const wager1Res = await request(app)
        .post(`/wallets/${walletId}/wagers`)
        .send({ amount: '60.00' });

      expect(wager1Res.status).toBe(200);
      expect(wager1Res.body.balance).toBe('40.000000000000000000');
      expect(wager1Res.body.accruedTurnover).toBe('60.000000000000000000');

      // 5. Withdrawal Attempt after Partial Wagering (Still BLOCKED)
      // Accrued 60 < Required 200, outstanding is 140
      const blockedWdr2Res = await request(app).post('/withdrawals').send({
        memberId,
        amount: '30.00',
      });

      expect(blockedWdr2Res.status).toBe(422);
      expect(blockedWdr2Res.body.error).toBe('turnover_unmet');
      expect(blockedWdr2Res.body.requiredTurnover).toBe('200.000000000000000000');
      expect(blockedWdr2Res.body.accruedTurnover).toBe('60.000000000000000000');
      expect(blockedWdr2Res.body.outstandingTurnover).toBe('140.000000000000000000');

      // 6. Reload Deposit to continue playing
      // Deposit 150.00 with multiplier = 0 (promotional reload without turnover requirement)
      const dep2Res = await request(app).post('/deposits').send({
        memberId,
        amount: '150.00',
        turnoverMultiplier: 0,
      });
      expect(dep2Res.status).toBe(201);
      await request(app).post('/psp/callbacks').send({
        pspRef: dep2Res.body.pspRef,
        status: 'completed',
        amount: '150.00',
      });

      // Wallet now has 40 + 150 = 190 balance. Required turnover is still 200.
      wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('190.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('200.000000000000000000');

      // 7. Wager to Fulfill Outstanding Turnover
      // Wager 140.00 (accrues 140, total accrued becomes 60 + 140 = 200 >= 200)
      const wager2Res = await request(app)
        .post(`/wallets/${walletId}/wagers`)
        .send({ amount: '140.00' });

      expect(wager2Res.status).toBe(200);
      expect(wager2Res.body.balance).toBe('50.000000000000000000');
      expect(wager2Res.body.accruedTurnover).toBe('200.000000000000000000');

      // 8. Withdrawal Request now UNLOCKED & SUCCEEDS
      // Alice withdraws 35.00
      const successWdrRes = await request(app).post('/withdrawals').send({
        memberId,
        amount: '35.00',
      });

      expect(successWdrRes.status).toBe(201);
      expect(successWdrRes.body.withdrawalId).toBeDefined();
      expect(successWdrRes.body.status).toBe('pending');
      expect(successWdrRes.body.amount).toBe('35.000000000000000000');
      expect(successWdrRes.body.balance).toBe('15.000000000000000000');

      // Verify wallet balance debited immediately into escrow
      wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('15.000000000000000000');

      // 9. Full Ledger Audit & Reconstructibility Invariant Check
      const audit = await auditLedgerBalance(walletId);
      expect(audit.entryCount).toBe(5); // 2 deposits, 2 wagers, 1 withdrawal
      expect(audit.calculatedBalance).toBe('15.000000000000000000');
      expect(audit.dbBalance).toBe('15.000000000000000000');
    });
  });

  describe('2. Sequential Duplicate Callback Idempotency', () => {
    it('acknowledges duplicate sequential callbacks with 200 OK without double-crediting', async () => {
      const { memberId, walletId } = await createTestMember('bob_seq_cb');

      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '80.00',
        turnoverMultiplier: 1,
      });
      const pspRef = depRes.body.pspRef;

      // First webhook delivery
      const cb1 = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '80.00',
      });
      expect(cb1.status).toBe(200);
      expect(cb1.body.idempotent).toBe(false);

      // Verify initial credit
      let wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('80.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('80.000000000000000000');

      // Second webhook delivery (e.g. PSP network retry 1 minute later)
      const cb2 = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '80.00',
      });
      expect(cb2.status).toBe(200);
      expect(cb2.body.idempotent).toBe(true);
      expect(cb2.body.status).toBe('completed');

      // Third webhook delivery (another retry)
      const cb3 = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '80.00',
      });
      expect(cb3.status).toBe(200);
      expect(cb3.body.idempotent).toBe(true);

      // Verify wallet balance was NOT duplicated
      wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('80.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('80.000000000000000000');

      // Ledger has strictly 1 entry
      const audit = await auditLedgerBalance(walletId);
      expect(audit.entryCount).toBe(1);
      expect(audit.calculatedBalance).toBe('80.000000000000000000');
    });
  });

  describe('3. Failed PSP Callback Lifecycle', () => {
    it('marks funding transaction failed and preserves zero wallet balance and ledger idempotency', async () => {
      const { memberId, walletId } = await createTestMember('charlie_failed_cb');

      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '50.00',
        turnoverMultiplier: 1,
      });
      const pspRef = depRes.body.pspRef;

      // PSP notifies that the payment failed (e.g. card declined or bank rejected)
      const cbRes = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'failed',
        amount: '50.00',
      });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('failed');
      expect(cbRes.body.idempotent).toBe(false);

      // Wallet balance must remain untouched
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('0.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('0.000000000000000000');

      // Ledger must remain empty
      const audit = await auditLedgerBalance(walletId);
      expect(audit.entryCount).toBe(0);

      // Subsequent callback delivery (even if claiming 'completed') must be rejected idempotently
      const retryRes = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '50.00',
      });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.status).toBe('failed');
      expect(retryRes.body.idempotent).toBe(true);

      // Wallet still 0
      const walletAfterRetry = await Wallet.findByPk(walletId);
      expect(walletAfterRetry!.balance).toBe('0.000000000000000000');
    });
  });

  describe('4. Hostile PSP Amount Mismatch Policy', () => {
    it('neutralizes mismatched callback amounts, marks transaction failed, and prevents wallet corruption', async () => {
      const { memberId, walletId } = await createTestMember('dave_mismatch');

      // Dave initiates deposit of 100.00
      const depRes = await request(app).post('/deposits').send({
        memberId,
        amount: '100.00',
        turnoverMultiplier: 1,
      });
      const pspRef = depRes.body.pspRef;

      // Malicious or buggy PSP callback claims completed with 150.00
      const cbRes = await request(app).post('/psp/callbacks').send({
        pspRef,
        status: 'completed',
        amount: '150.00',
      });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('failed');
      expect(cbRes.body.reason).toBe('amount_mismatch');
      expect(cbRes.body.idempotent).toBe(false);

      // Verify funding transaction row is marked failed with reason
      const fundingTx = await FundingTransaction.findOne({ where: { pspRef } });
      expect(fundingTx!.status).toBe('failed');
      expect(fundingTx!.failureReason).toBe('amount_mismatch');

      // Wallet was not credited
      const wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('0.000000000000000000');

      // No ledger entry created
      const audit = await auditLedgerBalance(walletId);
      expect(audit.entryCount).toBe(0);
    });
  });

  describe('5. Multi-Deposit Compounding Turnover Barrier', () => {
    it('accurately accumulates turnover requirements across multiple deposits and tests exact unlock boundary', async () => {
      const { memberId, walletId } = await createTestMember('eve_compounding');

      // Deposit 1: 100 with multiplier 2 -> +200 required turnover
      const dep1 = await request(app).post('/deposits').send({
        memberId,
        amount: '100.00',
        turnoverMultiplier: 2,
      });
      await request(app).post('/psp/callbacks').send({
        pspRef: dep1.body.pspRef,
        status: 'completed',
        amount: '100.00',
      });

      // Deposit 2: 50 with multiplier 3 -> +150 required turnover (Total Required = 350)
      const dep2 = await request(app).post('/deposits').send({
        memberId,
        amount: '50.00',
        turnoverMultiplier: 3,
      });
      await request(app).post('/psp/callbacks').send({
        pspRef: dep2.body.pspRef,
        status: 'completed',
        amount: '50.00',
      });

      let wallet = await Wallet.findByPk(walletId);
      expect(wallet!.balance).toBe('150.000000000000000000');
      expect(wallet!.requiredTurnover).toBe('350.000000000000000000');
      expect(wallet!.accruedTurnover).toBe('0.000000000000000000');

      // Attempt withdrawal: blocked, outstanding = 350
      const wdr1 = await request(app).post('/withdrawals').send({ memberId, amount: '50.00' });
      expect(wdr1.status).toBe(422);
      expect(wdr1.body.outstandingTurnover).toBe('350.000000000000000000');

      // Place wager of 150.00 (all funds) -> Balance = 0, Accrued = 150, Outstanding = 200
      await request(app).post(`/wallets/${walletId}/wagers`).send({ amount: '150.00' });

      // Deposit 3: 300 with multiplier 0 -> Required remains 350, Balance = 300
      const dep3 = await request(app).post('/deposits').send({
        memberId,
        amount: '300.00',
        turnoverMultiplier: 0,
      });
      await request(app).post('/psp/callbacks').send({
        pspRef: dep3.body.pspRef,
        status: 'completed',
        amount: '300.00',
      });

      // Place wager of 199.999999999999999999 -> Total accrued = 349.999999999999999999 (< 350)
      await request(app)
        .post(`/wallets/${walletId}/wagers`)
        .send({ amount: '199.999999999999999999' });

      // Withdrawal must still be blocked by 0.000000000000000001
      const wdrBoundary = await request(app).post('/withdrawals').send({ memberId, amount: '10.00' });
      expect(wdrBoundary.status).toBe(422);
      expect(wdrBoundary.body.outstandingTurnover).toBe('0.000000000000000001');

      // Place micro-wager of 0.000000000000000001 -> Accrued becomes exactly 350.000000000000000000!
      await request(app)
        .post(`/wallets/${walletId}/wagers`)
        .send({ amount: '0.000000000000000001' });

      // Withdrawal now succeeds!
      const wdrSuccess = await request(app).post('/withdrawals').send({ memberId, amount: '50.00' });
      expect(wdrSuccess.status).toBe(201);
      expect(wdrSuccess.body.balance).toBe('50.000000000000000000');

      // Audit ledger
      const audit = await auditLedgerBalance(walletId);
      expect(audit.calculatedBalance).toBe('50.000000000000000000');
      expect(audit.dbBalance).toBe('50.000000000000000000');
    });
  });
});
