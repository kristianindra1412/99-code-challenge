# Architecture Decisions & Technical Trade-Offs

**Candidate**: Kristian Indra  
**Role**: Backend Lead  
**Context**: Mini Wallet Service

---

## 1. Concurrency & Locking Strategy

### Database Row Locking (`SELECT ... FOR UPDATE`)
All balance mutations and webhook callbacks use PostgreSQL row-level pessimistic locking (`SELECT ... FOR UPDATE` via Sequelize transactions).

In transactional financial systems with high write contention on individual wallets (e.g. rapid bets or bursts of webhook callbacks), row-level pessimistic locking provides:
- **Strict FIFO ordering**: Competing requests queue deterministically on the database row lock. Each transaction reads the latest committed balance, performs validation, updates the balance, appends a ledger entry, and commits within milliseconds. The next queued request evaluates against the updated state.
- **Predictable latency under load**: Unlike Optimistic Concurrency Control (OCC with version checks), pessimistic locking avoids retry storms. Under high contention, OCC causes frequent serialization failures, forcing application-level retries with exponential backoff that consume CPU, saturate connection pools, and degrade tail latency.
- **ACID lifecycle binding**: In-memory distributed locks (e.g., Redis/Redlock) introduce split-brain risks if network partitions or process pauses cause lock TTLs to expire while a database transaction is still executing. Postgres row locks are physically tied to the transaction lifecycle; if the process crashes or the connection drops, PostgreSQL releases the lock immediately.

### Deadlock Prevention: Deterministic Lock Hierarchy
Deadlocks occur when transactions acquire multiple locks in conflicting orders. To prevent deadlocks, the codebase enforces a strict global acquisition order:

`FundingTransaction` -> `Wallet`

- **PSP Callbacks**: Lock `FundingTransaction` first by `pspRef`, then lock `Wallet`.
- **Wagers**: Only lock `Wallet` (no funding transaction involved).
- **Withdrawals**: Lock `Wallet` first; the `FundingTransaction` record is an insert (no existing row to lock).

Because no operation locks `Wallet` before querying/locking an existing `FundingTransaction`, circular wait conditions cannot occur.

---

## 2. Schema Design & Financial Ledger

### Running Balance + Append-Only Ledger
The system maintains a dual-state model:
1. `wallets.balance`: Mutable `DECIMAL(36, 18)` running balance.
2. `wallet_txs`: Immutable, append-only ledger recording every credit and debit.

**Trade-off rationale:**
- Calculating balances on-the-fly via `SUM(credits) - SUM(debits)` from `wallet_txs` creates $O(N)$ read scaling that becomes unsustainable as transaction volume grows.
- Maintaining `wallets.balance` allows $O(1)$ balance verification during wagers and withdrawals on the row already locked for update.
- Complete auditability is preserved because every balance modification writes a corresponding row to `wallet_txs` inside the same ACID transaction. Each ledger entry records `direction` (`credit`/`debit`), `amount`, and `balance_after` (a point-in-time balance snapshot).
- Reconstructibility invariant: at any point, the wallet balance can be verified or reconstructed from the ledger:
  `balance = sum(credits) - sum(debits)`.

### Defense-in-Depth: Database Check Constraint
In addition to application-level checks, PostgreSQL enforces balance non-negativity at the storage engine level:
```sql
ALTER TABLE wallets ADD CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0);
```
Even if an application-level bug bypassed validation, PostgreSQL rejects any write resulting in a negative balance.

### Turnover Tracking on `wallets`
Rather than aggregating lifetime deposits and wagers on every withdrawal request, running totals `required_turnover` and `accrued_turnover` are stored on the `wallets` table:
- Deposit completion: `required_turnover += amount * turnoverMultiplier`.
- Wager recording: `accrued_turnover += wager_amount`.
- Withdrawal check: verified in $O(1)$ via `accrued_turnover >= required_turnover`.

---

## 3. Webhook Handling & Hostile PSP Scenarios

External payment providers operate in unreliable environments (network retries, concurrent delivery, payload discrepancies). The callback handler is designed with defensive invariants:

### 1. In-Flight Replays & Idempotency
- Incoming callbacks query `funding_transactions` with `FOR UPDATE` by `pspRef`.
- If two identical callbacks arrive concurrently, the second waits for the first to commit. Upon acquiring the lock, it observes `status !== 'pending'`.
- The handler returns HTTP 200 with `{ status: fundingTx.status, idempotent: true }` without modifying wallet balances or writing ledger records.

### 2. Callback Amount Mismatch Policy
- **Scenario**: A deposit was created for `100.00`, but the callback reports `amount: "150.00"` or `"50.00"`.
- **Policy**: The transaction is marked `failed` with `failure_reason = 'amount_mismatch'`. No funds are credited to the wallet, and no ledger entry is created.
- **Rationale**: Auto-crediting the callback amount risks crediting fraudulent or misattributed funds. Auto-crediting the original amount creates accounting discrepancies against actual PSP settlements. Halting the transaction and requiring operational/reconciliation review is the safest financial approach.

### 3. Unknown `pspRef`
Callbacks referencing an unknown `pspRef` return `404 Not Found`. Records are never created dynamically from incoming webhooks, preventing malicious injection of arbitrary records.

### 4. Terminal State Immutability
Once a funding transaction reaches `completed` or `failed`, its state is final. Late callbacks cannot alter terminal transactions.

---

## 4. Withdrawal Escrow & Error Handling

### Immediate Escrow Deduction
When a withdrawal is requested, funds are debited from the wallet balance immediately:
- Prevents players from double-spending or wagering funds that are pending payout.
- If the withdrawal is subsequently declined or fails at the PSP level, a compensating transaction restores the balance with a `credit` entry in `wallet_txs`.

### Structured Turnover Error (HTTP 422)
When a withdrawal is blocked due to unmet turnover, the API returns a structured HTTP 422 response:
```json
{
  "error": "turnover_unmet",
  "requiredTurnover": "200.000000000000000000",
  "accruedTurnover": "60.000000000000000000",
  "outstandingTurnover": "140.000000000000000000"
}
```
This allows frontends and support teams to display the exact remaining turnover required to unlock withdrawals.

---

## 5. Coding Standards & Precision

- **Monetary Precision**: Money is stored as `DECIMAL(36, 18)` in PostgreSQL, serialized as strings in JSON/API boundaries, and processed via `bignumber.js` (configured to 18 decimal places with `ROUND_DOWN`). JavaScript floating-point numbers are never used for monetary math.
- **Minimal Dependencies**: The implementation relies strictly on Express, PostgreSQL, Sequelize, and Zod without introducing unnecessary message queues or cache layers.
- **Migrations**: All schema changes are applied via timestamped Sequelize migrations.

---

## 6. Assumptions & Framing Missing Constraints

The challenge leaves several real-world gaps. The following assumptions were framed and built directly into the system:

1. **Callback Amount Discrepancies**:
   - *Gap*: The prompt notes callback amount may differ from deposit amount without prescribing action.
   - *Assumption*: Discrepancies are treated as security/accounting exceptions. The transaction transitions to `failed` (`failure_reason = 'amount_mismatch'`), halting with zero wallet credit or ledger write. Discrepancies must be investigated by operations.
2. **Unknown `pspRef` Ingress**:
   - *Gap*: Callbacks may send an unknown reference.
   - *Assumption*: Return HTTP 404. Creating placeholder records from unauthenticated external webhooks introduces an injection vector for phantom transactions.
3. **Withdrawal Balance Timing (Escrow vs Pending)**:
   - *Gap*: Withdrawals enter a `pending` state awaiting manual approval.
   - *Assumption*: Wallet balance is debited immediately into escrow. Allowing funds to remain available while awaiting approval would permit players to wager away money already requested for cashout. If declined later, a compensating credit restores the balance.
4. **Cumulative Turnover Accumulation**:
   - *Gap*: How turnover requirements compound across multiple deposits and wagers.
   - *Assumption*: Turnover requirements aggregate cumulatively on the wallet (`required_turnover += deposit * multiplier`, `accrued_turnover += wager`). A member can withdraw whenever `accrued_turnover >= required_turnover`. Wagers do not reset after a withdrawal in this starter scope.
5. **Terminal State Immutability**:
   - *Gap*: Handling callbacks arriving out of order or after a transaction was marked failed/completed.
   - *Assumption*: Terminal states are irreversible. To stop PSP webhook retry loops, subsequent deliveries return HTTP 200 with `{ idempotent: true }` but perform zero database mutations.
6. **Decimal Precision Boundaries**:
   - *Gap*: Format and limits on string decimals.
   - *Assumption*: Adhere to `DECIMAL(36, 18)` throughout the stack. Inputs with more than 18 decimal places, negative numbers, or non-decimal formatting are rejected at the Zod boundary.

---

## 7. AI Tool Disclosure & Time Spent

In accordance with repo instructions, I want to be honest and straightforward about the tools used and time spent on this project:

- **Tools Used**: Antigravity and Gemini Flash.
- **Time Spent**: Completed within approximately 4 hours of active work, with some breaks (including a lunch break) in between.
- **Brainstorming & Acceleration**: Used to accelerate development by brainstorming solutions, generating code implementations according to the proposed architecture, and assisting in constructing verification test cases (including concurrency stress tests and edge cases).
- **Review & Alignment**: All planning, generated code, and test outputs were thoroughly reviewed, edited, and corrected to ensure they aligned with the architectural plan, financial correctness rules, and repository conventions.

---

## 8. Production Roadmap

Given additional time and production scope, the following improvements would be prioritized:

1. **Transactional Outbox Pattern**: Write domain events (`deposit.completed`, `withdrawal.requested`) to an `outbox` table within the same PostgreSQL transaction. A separate relay process (e.g. Debezium or poller) publishes these events to Kafka/RabbitMQ for downstream consumer services (risk, analytics, notifications) without dual-write inconsistency.
2. **Automated Reconciliation Job**: A scheduled background job to continuously cross-check running wallet balances against the sum of ledger entries:
   ```sql
   SELECT w.id, w.balance, COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0) AS calculated_sum
   FROM wallets w
   LEFT JOIN wallet_txs l ON l.wallet_id = w.id
   GROUP BY w.id, w.balance
   HAVING w.balance != COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0);
   ```
   Any mismatch triggers high-priority alerts for investigation.
3. **Turnover Bucketing**: Transitioning running turnover counters to discrete promo/bonus buckets to support campaign-specific rules, expiration dates, and game-weighting categories.
