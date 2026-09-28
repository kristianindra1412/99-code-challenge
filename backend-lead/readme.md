# Backend Lead - Take-Home Challenge

**Time budget: ~4 hours** (about 3h coding + 45 min for a short design note). We respect your time: when you hit the limit, stop and write down what you would do next in `DECISIONS.md`. An unfinished solution with clear reasoning beats a polished one that took two days.

## Context

We operate a regulated, real-money transactional platform with high transaction volume. Players hold wallets; money enters through third-party payment service providers (PSPs) and leaves through withdrawals. Correctness of money movement is the single most important property of the system - a bug here is not a bug, it is an incident.

You'll work in a small starter codebase ([`starter/`](starter/)) that mirrors our real stack and conventions: TypeScript, Express, Sequelize, PostgreSQL, Jest. Take your own copy of this repository (see the [root readme](../readme.md)) and work in `backend-lead/starter/`. Read [its README](starter/README.md) first - the conventions listed there are part of the exercise.

## Part A - Implement the deposit → wager → withdrawal flow (~3h)

### A1. Create a deposit

`POST /deposits`

```json
{ "memberId": "<uuid>", "amount": "100.50", "turnoverMultiplier": 1 }
```

Creates a funding transaction in a `Pending` state and returns `201` with the transaction id and a `pspRef` (an opaque reference you generate - the mock PSP will echo it back in the callback). No money moves yet.

- `amount` is a string decimal, must be positive.
- `turnoverMultiplier` is an integer ≥ 0 (see A4). Default 1.

### A2. Handle the PSP callback

`POST /psp/callbacks`

```json
{ "pspRef": "<ref>", "status": "completed", "amount": "100.50" }
```

This is the webhook our mock PSP calls when the payment finishes (`status` is `completed` or `failed`). Real PSPs are hostile infrastructure. Your handler must assume:

- **The same callback can be delivered more than once** - retries, sometimes minutes or hours late.
- **Two deliveries of the same callback can arrive concurrently** (two requests in flight at the same time).
- The `amount` in the callback may differ from the deposit amount. Decide what to do and document it.
- Callbacks may reference an unknown `pspRef`.

Requirements:

- A completed deposit credits the member's wallet **exactly once**, no matter how many times or how concurrently the callback is delivered.
- Every balance change writes an append-only ledger entry (`wallet_txs` or your own design) such that the wallet balance is always reconstructible from the ledger.
- The funding transaction moves through an explicit state machine (`Pending → Completed / Failed`); invalid transitions are rejected, not silently applied.

### A3. Record wagers

`POST /wallets/:walletId/wagers`

```json
{ "amount": "10.00" }
```

Debits the wallet (reject if insufficient balance) and accrues turnover (see A4). Ledger entry required, same concurrency expectations as A2 - two concurrent wagers must not overdraw the wallet.

### A4. Withdrawals with a turnover lock

`POST /withdrawals`

```json
{ "memberId": "<uuid>", "amount": "50.00" }
```

Business rule (this is real, it's an anti-abuse control): each completed deposit adds a **turnover requirement** of `amount × turnoverMultiplier`. Each wager accrues turnover equal to the wager amount. A member may only withdraw when their **accrued turnover ≥ total required turnover**. Otherwise return `422` with a body that tells the client how much turnover is still outstanding.

A valid withdrawal debits the wallet immediately and creates a funding transaction in `Pending` state (assume a human approves it later - you don't need to build approval).

### A5. Tests

Write tests for the risks that matter. At minimum we expect to see:

- Duplicate callback (sequential) does not double-credit.
- **Concurrent** duplicate callbacks do not double-credit.
- Concurrent wagers cannot overdraw a wallet.
- Turnover lock blocks and unblocks withdrawal correctly.

## Part B - Design note: the 50th PSP (~45 min)

Today there is one mock PSP. In production this platform integrates **dozens of PSPs, and the list grows constantly**. Each one has its own callback format, signature/verification scheme, status vocabulary, and quirks (some send amounts in minor units, some retry aggressively, some send `success` before `pending`).

In `DESIGN-PSP.md` (max ~1 page + a sketch), answer:

> How would you structure this codebase so that integrating a new PSP is a one-day task safely done by a junior engineer?

Cover: the interface/abstraction you'd define, where verification and normalization live, how config drives it, and how you'd test an integration against a provider you can't reliably call in CI. Code interfaces/pseudo-code welcome; a full implementation is not expected.

## Deliverables

- The `starter/` codebase with your implementation and tests, delivered so we can read your commit history - a link to your own repository is easiest, a zip with `.git` included works too. See the submission note in the [root readme](../readme.md).
- `DECISIONS.md` - the trade-offs you made and why (locking strategy, schema choices, what you'd do next with more time). This file is weighted heavily; an empty one is a red flag.
- `DESIGN-PSP.md` - Part B.

## Rules

- **AI tools are allowed.** Disclose in `DECISIONS.md` what you used them for. You own every line and every decision: the first interview digs into your reasoning, and "the AI did it" is a failing answer.
- Don't add heavy dependencies (queues, ORMs, frameworks) - the exercise fits in what's already there. Adding a small library is fine if you justify it.
- Keep the starter's conventions. Deviating is allowed if `DECISIONS.md` says why.

## What we evaluate

Money correctness, idempotency/concurrency handling, data modeling, test quality, code clarity, and the Part B design. We do **not** care about: auth, deployment, Docker hardening, exhaustive coverage of trivial code, or UI. `PATCH`-perfect REST semantics matter less than a wallet that never loses money.
