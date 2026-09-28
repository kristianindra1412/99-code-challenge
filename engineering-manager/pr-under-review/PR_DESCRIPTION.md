# PR #482 - Weekly cashback payout

**Author:** D. (mid-level BE, Payments squad, 2 years on the team)
**Reviewer:** S. (staff engineer, Payments squad) - **✅ Approved** ("LGTM, nice and simple")
**Target branch:** `staging` - scheduled to merge and deploy tomorrow morning.

## Description

Implements the weekly cashback feature from the promo roadmap:

- Every member gets **5% cashback on net losses** (total wagered − total won) over the trailing 7 days.
- New `cashback_payouts` table records each payout.
- Payouts credit the member wallet and write a ledger entry, consistent with the rest of the wallet code.
- New admin endpoint `POST /admin/cashback/run` triggers the run; ops will call it from the weekly cron. It takes `accountId` so each brand can be run separately.
- Unit tests added and passing. Also tested locally against seed data - numbers check out.

## Notes

- Kept it deliberately simple per S.'s advice - no queue, just a loop. We only have ~40k members per brand so this is fine.
- Follows the existing service/route split.

## Context for the reviewer (you)

This codebase is the wallet service you may have seen elsewhere in our hiring process: TypeScript / Express / Sequelize / Postgres. Money is `DECIMAL(36,18)` in Postgres and travels as strings; all money arithmetic is supposed to go through `bignumber.js` (`src/lib/money.ts` exports `dec()`). Multi-brand: every member belongs to an `accountId`, and **all queries in this codebase are expected to be scoped by `accountId`**. Existing tables: `members`, `wallets`, `wallet_txs` (append-only ledger), `bets` (columns: `id`, `member_id`, `account_id`, `amount`, `payout`, `created_at` - `amount` is the stake, `payout` is what the member got back, both DECIMAL strings).

The full diff is in `cashback-payout.diff`.
