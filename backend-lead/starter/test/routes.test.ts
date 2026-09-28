import request from 'supertest';
import { createApp } from '../src/app';
import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';
import * as memberService from '../src/services/memberService';

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

describe('API Routes & Validation Suite', () => {
  // Helper to create a member with wallet
  async function setupMember(username = 'tester01') {
    const { member, wallet } = await memberService.createMember(username);
    return { member, wallet };
  }

  // Helper to fund a wallet via deposit + callback
  async function fundWallet(memberId: string, amount: string, turnoverMultiplier = 1) {
    const depRes = await request(app)
      .post('/deposits')
      .send({ memberId, amount, turnoverMultiplier });
    expect(depRes.status).toBe(201);

    const cbRes = await request(app)
      .post('/psp/callbacks')
      .send({ pspRef: depRes.body.pspRef, status: 'completed', amount });
    expect(cbRes.status).toBe(200);

    return { deposit: depRes.body, callback: cbRes.body };
  }

  describe('POST /deposits', () => {
    it('creates a pending deposit with default turnoverMultiplier (1)', async () => {
      const { member } = await setupMember();

      const res = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.50' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.memberId).toBe(member.id);
      expect(res.body.amount).toBe('100.500000000000000000');
      expect(res.body.status).toBe('pending');
      expect(res.body.pspRef).toMatch(/^psp_dep_/);
      expect(res.body.turnoverMultiplier).toBe(1);

      // Verify no money moved into wallet yet
      const wallet = await Wallet.findOne({ where: { memberId: member.id } });
      expect(wallet!.balance).toBe('0.000000000000000000');
    });

    it('creates a pending deposit with custom turnoverMultiplier', async () => {
      const { member } = await setupMember();

      const res = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '250.00', turnoverMultiplier: 3 });

      expect(res.status).toBe(201);
      expect(res.body.turnoverMultiplier).toBe(3);
    });

    it('rejects missing memberId with 400 validation_error', async () => {
      const res = await request(app)
        .post('/deposits')
        .send({ amount: '50.00' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('rejects invalid memberId format (non-UUID) with 400 validation_error', async () => {
      const res = await request(app)
        .post('/deposits')
        .send({ memberId: 'not-a-uuid', amount: '50.00' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('rejects non-existent member with 404 not_found', async () => {
      const res = await request(app)
        .post('/deposits')
        .send({
          memberId: 'a0000000-0000-0000-0000-000000000001',
          amount: '50.00',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('rejects negative, zero, and non-numeric amounts with 400 validation_error', async () => {
      const { member } = await setupMember();

      const negRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '-50.00' });
      expect(negRes.status).toBe(400);

      const zeroRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '0.00' });
      expect(zeroRes.status).toBe(400);

      const nonNumRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: 'invalid' });
      expect(nonNumRes.status).toBe(400);
    });

    it('rejects JS number math attempts (Zero Floating-Point Rule enforcement)', async () => {
      const { member } = await setupMember();

      // Passing number instead of string decimal
      const res = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: 100.5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });

    it('rejects invalid turnover multipliers (negative, float) with 400', async () => {
      const { member } = await setupMember();

      const negMult = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '50.00', turnoverMultiplier: -1 });
      expect(negMult.status).toBe(400);

      const floatMult = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '50.00', turnoverMultiplier: 1.5 });
      expect(floatMult.status).toBe(400);
    });
  });

  describe('POST /psp/callbacks', () => {
    it('successfully processes a completed callback, credits wallet and adds turnover', async () => {
      const { member, wallet } = await setupMember();

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00', turnoverMultiplier: 2 });
      expect(depRes.status).toBe(201);

      const cbRes = await request(app)
        .post('/psp/callbacks')
        .send({
          pspRef: depRes.body.pspRef,
          status: 'completed',
          amount: '100.00',
        });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('completed');
      expect(cbRes.body.idempotent).toBe(false);

      // Verify wallet state
      const updatedWallet = await Wallet.findByPk(wallet.id);
      expect(updatedWallet!.balance).toBe('100.000000000000000000');
      expect(updatedWallet!.requiredTurnover).toBe('200.000000000000000000');

      // Verify ledger entry
      const ledgerEntry = await WalletTx.findOne({ where: { walletId: wallet.id } });
      expect(ledgerEntry).not.toBeNull();
      expect(ledgerEntry!.type).toBe('deposit');
      expect(ledgerEntry!.direction).toBe('credit');
      expect(ledgerEntry!.amount).toBe('100.000000000000000000');
      expect(ledgerEntry!.balanceAfter).toBe('100.000000000000000000');
    });

    it('returns idempotent: true and does NOT double-credit on sequential duplicate callback', async () => {
      const { member, wallet } = await setupMember();

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00' });

      // First delivery
      const cb1 = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '100.00' });
      expect(cb1.status).toBe(200);
      expect(cb1.body.idempotent).toBe(false);

      // Second delivery (duplicate retry)
      const cb2 = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '100.00' });
      expect(cb2.status).toBe(200);
      expect(cb2.body.idempotent).toBe(true);
      expect(cb2.body.status).toBe('completed');

      // Wallet must only be credited once
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('100.000000000000000000');

      // Only 1 ledger entry exists
      const count = await WalletTx.count({ where: { walletId: wallet.id } });
      expect(count).toBe(1);
    });

    it('handles failed callback without crediting wallet', async () => {
      const { member, wallet } = await setupMember();

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00' });

      const cbRes = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'failed', amount: '100.00' });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('failed');
      expect(cbRes.body.reason).toBe('psp_declined');

      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('0.000000000000000000');

      const tx = await FundingTransaction.findByPk(depRes.body.id);
      expect(tx!.status).toBe('failed');
      expect(tx!.failureReason).toBe('psp_declined');
    });

    it('marks transaction failed and prevents credit on amount mismatch', async () => {
      const { member, wallet } = await setupMember();

      const depRes = await request(app)
        .post('/deposits')
        .send({ memberId: member.id, amount: '100.00' });

      // Attacker or buggy PSP submits callback with different amount
      const cbRes = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: depRes.body.pspRef, status: 'completed', amount: '50.00' });

      expect(cbRes.status).toBe(200);
      expect(cbRes.body.status).toBe('failed');
      expect(cbRes.body.reason).toBe('amount_mismatch');

      // Wallet must remain 0
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('0.000000000000000000');

      // Funding transaction is marked failed
      const tx = await FundingTransaction.findByPk(depRes.body.id);
      expect(tx!.status).toBe('failed');
      expect(tx!.failureReason).toBe('amount_mismatch');
    });

    it('returns 404 for unknown pspRef', async () => {
      const res = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: 'psp_dep_non_existent', status: 'completed', amount: '100.00' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('rejects invalid callback payloads with 400 validation_error', async () => {
      const invStatus = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: 'ref', status: 'processing', amount: '100.00' });
      expect(invStatus.status).toBe(400);

      const emptyRef = await request(app)
        .post('/psp/callbacks')
        .send({ pspRef: '', status: 'completed', amount: '100.00' });
      expect(emptyRef.status).toBe(400);
    });
  });

  describe('POST /wallets/:walletId/wagers', () => {
    it('debits wallet and accrues turnover on valid wager', async () => {
      const { member, wallet } = await setupMember();
      await fundWallet(member.id, '100.00', 1);

      const wagerRes = await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '35.50' });

      expect(wagerRes.status).toBe(200);
      expect(wagerRes.body.walletId).toBe(wallet.id);
      expect(wagerRes.body.balance).toBe('64.500000000000000000');
      expect(wagerRes.body.accruedTurnover).toBe('35.500000000000000000');

      // Verify wallet row
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('64.500000000000000000');
      expect(refreshedWallet!.accruedTurnover).toBe('35.500000000000000000');

      // Verify ledger entry
      const wagerTx = await WalletTx.findOne({
        where: { walletId: wallet.id, type: 'wager' },
      });
      expect(wagerTx).not.toBeNull();
      expect(wagerTx!.direction).toBe('debit');
      expect(wagerTx!.amount).toBe('35.500000000000000000');
      expect(wagerTx!.balanceAfter).toBe('64.500000000000000000');
    });

    it('rejects wager when balance is insufficient with 422 insufficient_funds', async () => {
      const { member, wallet } = await setupMember();
      await fundWallet(member.id, '20.00');

      const res = await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '50.00' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('insufficient_funds');

      // Balance unchanged
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('20.000000000000000000');
    });

    it('returns 404 when walletId does not exist', async () => {
      const res = await request(app)
        .post('/wallets/a0000000-0000-0000-0000-000000000001/wagers')
        .send({ amount: '10.00' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('rejects invalid walletId format or invalid amount with 400', async () => {
      const invUuid = await request(app)
        .post('/wallets/invalid-uuid/wagers')
        .send({ amount: '10.00' });
      expect(invUuid.status).toBe(400);

      const { wallet } = await setupMember();
      const negAmount = await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '-5.00' });
      expect(negAmount.status).toBe(400);
    });
  });

  describe('POST /withdrawals', () => {
    it('rejects withdrawal with 422 turnover_unmet when turnover has not been satisfied', async () => {
      const { member, wallet } = await setupMember();
      // Deposit 100 with multiplier 2 -> required turnover = 200
      await fundWallet(member.id, '100.00', 2);

      // Wager only 50 -> accrued turnover = 50, outstanding = 150
      await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '50.00' });

      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '25.00' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('turnover_unmet');
      expect(res.body.requiredTurnover).toBe('200.000000000000000000');
      expect(res.body.accruedTurnover).toBe('50.000000000000000000');
      expect(res.body.outstandingTurnover).toBe('150.000000000000000000');

      // Balance unchanged
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('50.000000000000000000');
    });

    it('successfully processes withdrawal with 201 Created once turnover is met', async () => {
      const { member, wallet } = await setupMember();
      // Deposit 100 with multiplier 1 -> required turnover = 100
      await fundWallet(member.id, '100.00', 1);

      // Wager 100 -> accrued turnover = 100, outstanding = 0
      await request(app)
        .post(`/wallets/${wallet.id}/wagers`)
        .send({ amount: '100.00' });

      // Deposit another 50 with multiplier 0 -> required turnover stays 100, accrued is 100
      await fundWallet(member.id, '50.00', 0);

      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '30.00' });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.withdrawalId).toBeDefined();
      expect(res.body.memberId).toBe(member.id);
      expect(res.body.amount).toBe('30.000000000000000000');
      expect(res.body.balance).toBe('20.000000000000000000');
      expect(res.body.pspRef).toMatch(/^psp_wdr_/);
      expect(res.body.status).toBe('pending');

      // Wallet balance debited immediately into escrow
      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('20.000000000000000000');

      // Ledger entry exists
      const withdrawalTx = await WalletTx.findOne({
        where: { walletId: wallet.id, type: 'withdrawal' },
      });
      expect(withdrawalTx).not.toBeNull();
      expect(withdrawalTx!.direction).toBe('debit');
      expect(withdrawalTx!.amount).toBe('30.000000000000000000');
      expect(withdrawalTx!.balanceAfter).toBe('20.000000000000000000');
    });

    it('rejects withdrawal with 422 insufficient_funds when turnover is met but balance is too low', async () => {
      const { member, wallet } = await setupMember();
      // Deposit 100 with multiplier 0 -> required = 0, accrued = 0
      await fundWallet(member.id, '100.00', 0);

      // Attempt withdrawal of 150
      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: member.id, amount: '150.00' });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('insufficient_funds');

      const refreshedWallet = await Wallet.findByPk(wallet.id);
      expect(refreshedWallet!.balance).toBe('100.000000000000000000');
    });

    it('rejects withdrawal for non-existent member with 404', async () => {
      const res = await request(app)
        .post('/withdrawals')
        .send({
          memberId: 'a0000000-0000-0000-0000-000000000001',
          amount: '10.00',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('not_found');
    });

    it('rejects invalid payloads with 400 validation_error', async () => {
      const res = await request(app)
        .post('/withdrawals')
        .send({ memberId: 'not-a-uuid', amount: '10.00' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_error');
    });
  });

  describe('GET /members/:memberId/wallet', () => {
    it('returns balance and turnover metadata for member', async () => {
      const { member } = await setupMember('audit_user');
      await fundWallet(member.id, '100.00', 2);

      const res = await request(app).get(`/members/${member.id}/wallet`);
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe('100.000000000000000000');
      expect(res.body.requiredTurnover).toBe('200.000000000000000000');
      expect(res.body.accruedTurnover).toBe('0.000000000000000000');
    });
  });
});
