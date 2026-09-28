import { sequelize } from '../src/db/sequelize';
import { Member, Wallet, FundingTransaction, WalletTx } from '../src/db/models';

beforeAll(async () => {
  await sequelize.authenticate();
});

beforeEach(async () => {
  await sequelize.truncate({ cascade: true });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Models & Migrations Suite', () => {
  describe('FundingTransaction Model & Constraints', () => {
    it('creates a funding transaction with defaults and associations', async () => {
      const member = await Member.create({ username: 'bob01' });

      const tx = await FundingTransaction.create({
        memberId: member.id,
        type: 'deposit',
        amount: '100.500000000000000000',
        pspRef: 'psp_test_001',
      });

      expect(tx.id).toBeDefined();
      expect(tx.memberId).toBe(member.id);
      expect(tx.status).toBe('pending');
      expect(tx.turnoverMultiplier).toBe(1);
      expect(tx.failureReason).toBeNull();
      expect(tx.amount).toBe('100.500000000000000000');

      // Member -> FundingTransaction association
      const memberWithTxs = await Member.findByPk(member.id, {
        include: [{ model: FundingTransaction, as: 'fundingTransactions' }],
      });
      expect(memberWithTxs).not.toBeNull();
      const loadedTxs = (memberWithTxs as any).fundingTransactions;
      expect(loadedTxs).toHaveLength(1);
      expect(loadedTxs[0].pspRef).toBe('psp_test_001');

      // FundingTransaction -> Member association
      const txWithMember = await FundingTransaction.findByPk(tx.id, {
        include: [{ model: Member, as: 'member' }],
      });
      expect(txWithMember).not.toBeNull();
      expect((txWithMember as any).member.username).toBe('bob01');
    });

    it('enforces uniqueness on psp_ref at the database level', async () => {
      const member = await Member.create({ username: 'bob02' });

      await FundingTransaction.create({
        memberId: member.id,
        type: 'deposit',
        amount: '50.000000000000000000',
        pspRef: 'psp_duplicate_ref',
      });

      await expect(
        FundingTransaction.create({
          memberId: member.id,
          type: 'deposit',
          amount: '50.000000000000000000',
          pspRef: 'psp_duplicate_ref',
        }),
      ).rejects.toThrow();
    });
  });

  describe('Wallet Model Turnover & Balance Check Constraint', () => {
    it('initializes wallet with zero required and accrued turnover', async () => {
      const member = await Member.create({ username: 'bob03' });
      const wallet = await Wallet.create({ memberId: member.id, balance: '0' });

      expect(wallet.balance).toBe('0.000000000000000000');
      expect(wallet.requiredTurnover).toBe('0.000000000000000000');
      expect(wallet.accruedTurnover).toBe('0.000000000000000000');
    });

    it('enforces non-negative balance check constraint chk_wallets_balance_non_negative', async () => {
      const member = await Member.create({ username: 'bob04' });
      const wallet = await Wallet.create({ memberId: member.id, balance: '10' });

      // Updating balance to negative must be rejected by PostgreSQL constraint
      await expect(
        wallet.update({ balance: '-0.000000000000000001' }),
      ).rejects.toThrow();
    });
  });

  describe('WalletTx Append-Only Ledger & Associations', () => {
    it('creates a credit ledger entry linked to a funding transaction', async () => {
      const member = await Member.create({ username: 'bob05' });
      const wallet = await Wallet.create({ memberId: member.id, balance: '100' });
      const fundingTx = await FundingTransaction.create({
        memberId: member.id,
        type: 'deposit',
        amount: '100',
        pspRef: 'psp_dep_100',
        status: 'completed',
      });

      const ledgerEntry = await WalletTx.create({
        walletId: wallet.id,
        fundingTxId: fundingTx.id,
        type: 'deposit',
        amount: '100.000000000000000000',
        direction: 'credit',
        balanceAfter: '100.000000000000000000',
      });

      expect(ledgerEntry.id).toBeDefined();
      expect(ledgerEntry.createdAt).toBeDefined();

      // Wallet -> WalletTx association via 'transactions' and 'ledgerEntries'
      const walletWithTxs = await Wallet.findByPk(wallet.id, {
        include: [{ model: WalletTx, as: 'transactions' }],
      });
      expect((walletWithTxs as any).transactions).toHaveLength(1);
      expect((walletWithTxs as any).transactions[0].direction).toBe('credit');

      const walletWithLedger = await Wallet.findByPk(wallet.id, {
        include: [{ model: WalletTx, as: 'ledgerEntries' }],
      });
      expect((walletWithLedger as any).ledgerEntries).toHaveLength(1);

      // FundingTransaction -> WalletTx association
      const fundingWithLedger = await FundingTransaction.findByPk(fundingTx.id, {
        include: [{ model: WalletTx, as: 'ledgerEntry' }],
      });
      expect((fundingWithLedger as any).ledgerEntry.id).toBe(ledgerEntry.id);

      // WalletTx -> FundingTransaction association
      const ledgerWithFunding = await WalletTx.findByPk(ledgerEntry.id, {
        include: [{ model: FundingTransaction, as: 'fundingTransaction' }],
      });
      expect((ledgerWithFunding as any).fundingTransaction.pspRef).toBe('psp_dep_100');
    });

    it('creates a debit ledger entry for wagers with null fundingTxId', async () => {
      const member = await Member.create({ username: 'bob06' });
      const wallet = await Wallet.create({ memberId: member.id, balance: '50' });

      const wagerLedger = await WalletTx.create({
        walletId: wallet.id,
        fundingTxId: null,
        type: 'wager',
        amount: '10.000000000000000000',
        direction: 'debit',
        balanceAfter: '40.000000000000000000',
      });

      expect(wagerLedger.id).toBeDefined();
      expect(wagerLedger.fundingTxId).toBeNull();
      expect(wagerLedger.type).toBe('wager');
      expect(wagerLedger.direction).toBe('debit');
      expect(wagerLedger.balanceAfter).toBe('40.000000000000000000');
    });
  });
});
