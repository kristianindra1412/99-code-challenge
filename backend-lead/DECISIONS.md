# Architectural Decisions & Technical Trade-Offs

> **Project**: Backend Lead Take-Home Challenge (Mini Wallet Service)  
> **Author**: Kristian Indra  
> **Perspective**: Practical Engineering Leadership & Production Realities

---

## 1. Concurrency & Locking Strategy

### The Choice: Pessimistic Row Locking (`SELECT ... FOR UPDATE`)
For every balance mutation and webhook callback, I chose **database-level pessimistic row locking** (`SELECT ... FOR UPDATE` via Sequelize's `transaction.LOCK.UPDATE`). 

In fintech and real-money gaming, locking isn't just an abstract Computer Science problem—it directly dictates whether your on-call engineer sleeps through the night or spends 3:00 AM manually reconciling balances.

### Why I Rejected Optimistic Concurrency Control (OCC)
On paper, optimistic concurrency control (adding a `version` column and doing `WHERE version = :old`) sounds elegant and lightweight. But under real-world conditions, OCC fails exactly when you need it most:
- **The Player Experience**: Picture a high-volatility slot game or a live crash game where multiple bets or fast clicks land within milliseconds. With OCC, 1 bet commits and the other 9 explode with version conflict errors. 
- **The Retry Nightmare**: To patch over those failures, you have to build retry loops with jitter and exponential backoff in Node.js. Now, under peak traffic (like the last 2 minutes of the World Cup final), your application servers are wasting CPU cycles repeatedly failing and retrying against PostgreSQL, driving latency through the roof.
- **Fair Ordering**: Pessimistic locking gives us something OCC cannot: **deterministic FIFO queueing**. PostgreSQL queues competing requests on the row lock tuple. Each transaction finishes in 1–2 milliseconds—it grabs the lock, checks the balance, applies the deduction, logs the ledger row, and commits. The next request in line immediately inherits the lock and evaluates against the freshly committed balance. No retries, no wasted CPU, no player frustration.

### Why I Rejected Distributed In-Memory Locks (Redis / Redlock)
Besides adhering to the prompt's rule to avoid heavy extra infrastructure, distributed locks introduce dangerous dual-state failure modes:
- If Redis suffers a network blip, or a Node.js process pauses for garbage collection, a distributed lock TTL can expire while the database transaction is still executing. Suddenly, another worker acquires the lock, and you have two processes mutating the same wallet simultaneously (split-brain).
- By keeping the lock inside PostgreSQL, the lock lifecycle is **physically tied to the database transaction**. If the connection drops or the query fails, PostgreSQL releases the lock automatically. There is zero chance of a lock state drifting from the database state.

### Preventing Deadlocks: Deterministic Lock Hierarchy
Deadlocks happen when two transactions try to lock the same resources in opposite orders (e.g., Transaction A locks `FundingTx` then `Wallet`; Transaction B locks `Wallet` then `FundingTx`).

To ensure we never hit a deadlock (`40P01` error in Postgres), I established a strict global rule:
$$\text{FundingTransaction} \longrightarrow \text{Wallet}$$

- In `pspCallbackService`: We lock `funding_transactions` first, then lock `wallets`.
- In `withdrawalService`: We lock `wallets` first; the withdrawal `funding_transactions` record is an insert (no existing row to lock).
- In `wagerService`: Only `wallets` is touched.
- Because no code path ever locks `wallets` before an existing `funding_transactions` row, circular wait conditions are impossible.

---

## 2. Schema Design & Financial Ledgering

### Pragmatism vs. Dogmatism: Cached Balance + Append-Only Ledger
In financial systems, there's always a debate: *should we use pure event sourcing (only ledger entries) or maintain a running balance?*

I opted for a **dual-state architecture**:
1. `wallets.balance`: A cached, mutable column (`DECIMAL(36, 18)`).
2. `wallet_txs`: An immutable, append-only ledger recording every single credit and debit.

**The Human / Operational Rationale:**
- In pure event sourcing, every time a player spins a slot or places a bet, you have to run `SELECT SUM(credits) - SUM(debits) FROM wallet_txs WHERE wallet_id = :id`. When an active player has thousands of historical spins, computing this on every request thrashes database I/O and introduces unacceptable latency for real-time gaming.
- By keeping `balance` on the `wallets` row, balance checks are instant $O(1)$ lookups on a row we already locked.
- Meanwhile, `wallet_txs` remains the **ultimate legal and regulatory source of truth**. Every single balance change writes a ledger row inside the exact same ACID transaction. Every ledger row records `direction`, `amount`, and `balance_after` (a point-in-time balance snapshot).
- If there is ever any suspicion of data tampering or an operational discrepancy, our automated audit query can reconstruct the entire wallet balance from day one:
  $$\text{Wallet Balance} \equiv \sum \text{Credits} - \sum \text{Debits}$$

### Running Turnover Counters on `wallets`
Rather than recalculating lifetime deposits multiplied by their individual promo multipliers and subtracting lifetime wagers on every withdrawal request, I added `required_turnover` and `accrued_turnover` directly to `wallets`:
- When a deposit completes: `required_turnover += amount * turnoverMultiplier`.
- When a wager occurs: `accrued_turnover += wager_amount`.
- When a withdrawal is requested: checking whether the player can withdraw is a simple $O(1)$ check: `accrued_turnover >= required_turnover`.

### Defense-in-Depth: The Database Check Constraint
Even the best engineers can make a typo, or a future refactor might accidentally bypass a validation check. To guard against human error, I added a hard constraint directly to PostgreSQL:
```sql
ALTER TABLE wallets ADD CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0);
```
If an application bug ever attempted to set a negative balance, the PostgreSQL engine itself will reject the write at the disk level. It is impossible to overdraw a wallet in this system.

---

## 3. Hostile PSPs & Real-World Webhook Handling

Payment Service Providers (PSPs) operate in chaotic environments. Their servers retry aggressively during network hiccups, drop webhooks, or send callbacks out of sequence. Our webhook handler treats PSPs as untrusted external actors:

### 1. In-Flight Replays & Idempotency
- When a webhook arrives, we immediately lock the `funding_transactions` row with `FOR UPDATE`.
- If two webhooks arrive in the exact same millisecond, the first acquires the lock, changes status to `completed`, credits the wallet, writes the ledger entry, and commits.
- The second webhook was waiting in the PostgreSQL lock queue. When it wakes up, it sees `status !== 'pending'`. 
- The idempotency check intercepts it immediately:
  ```typescript
  if (fundingTx.status !== 'pending') {
    return { status: fundingTx.status, idempotent: true };
  }
  ```
- It returns HTTP `200 OK` so the PSP knows to stop retrying, but **does not touch the wallet or ledger**.

### 2. Callback Amount Mismatch Policy (The Honest Business Decision)
- **The Scenario**: A player initiates a $100.00 deposit, but the PSP callback reports `amount: "150.00"` (or `$50.00`).
- **Why Not Auto-Credit $150?** If we credit $150, we might be crediting phantom funds if the webhook was tampered with, buggy, or intended for another transaction.
- **Why Not Auto-Credit $100?** If the customer was actually charged $150 at their bank, crediting $100 causes immediate customer fury and reconciliation nightmares between our bank accounts and platform ledger.
- **The Chosen Policy**: We halt immediately. We mark the transaction `failed` with `failure_reason: 'amount_mismatch'`, write zero ledger rows, and leave the wallet untouched. In production, this fires an alert to our Finance / Operations Slack channel so an actual human can inspect the PSP dashboard and resolve the mismatch.

### 3. Unknown `pspRef`
If a callback references a `pspRef` that doesn't exist, we return `404 Not Found`. We deliberately do not create a record on the fly; that would allow malicious actors to inject arbitrary pending records into our database.

### 4. Terminal State Immutability
Once a funding transaction reaches `completed` or `failed`, its lifecycle is frozen. A failed deposit cannot magically be resurrected into completed by a late callback. If a payment truly succeeded after failure was declared, the support team or automated reconciliation initiates a clean correction rather than mutating historical state.

---

## 4. Withdrawal Escrow & Customer Support Considerations

### Why We Immediately Escrow Funds on Withdrawal
When a player submits a valid withdrawal request, we **immediately deduct the amount from their wallet balance**:
- **The Human Psychology Problem**: If we leave the funds in the player's balance while waiting for manual fraud/finance review (which could take 12–24 hours), the player might continue playing, hit a losing streak, and spend the money they intended to cash out. When finance finally approves the withdrawal, the transaction fails for insufficient funds, leading to angry support tickets and chargebacks.
- **The Escrow Solution**: By debiting the balance immediately and recording a `withdrawal` ledger debit, the funds are safely locked away. If finance or the PSP ultimately rejects the withdrawal, a compensating `withdrawal_refund` credit restores the funds to their wallet with an auditable trail.

### Empowering Customer Support on Turnover Locks
Anti-Money Laundering (AML) rules require turnover locks, but nothing frustrates a customer more than a generic "Action not allowed" error.

When a player's withdrawal is rejected for unmet turnover, our API returns an explicit HTTP 422 payload:
```json
{
  "error": "turnover_unmet",
  "requiredTurnover": "200.000000000000000000",
  "accruedTurnover": "60.000000000000000000",
  "outstandingTurnover": "140.000000000000000000"
}
```
This enables frontend banners and customer support agents to give exact answers: *"You've wagered $60 of your $200 requirement. You only need $140 more in gameplay to unlock your cashout."* It turns a potential support complaint into clear, transparent guidance.

---

## 5. Conventions & Dependencies

I respected the starter's architecture and constraints:
- **Precision**: Money is `DECIMAL(36, 18)` in PostgreSQL, string primitives across JSON and API boundaries, and `BigNumber` via `src/lib/money.ts` in memory. Not a single monetary calculation touches JavaScript floating-point math.
- **Zero Heavy Dependencies**: No Redis, RabbitMQ, Kafka, or alternative ORMs were added. The solution solves race conditions, idempotency, and auditability entirely within Express, PostgreSQL, and Sequelize.
- **Migrations Over Sync**: All database structures were built using timestamped Sequelize migrations under `src/db/migrations/`.

---

## 6. AI Disclosure & Engineering Ownership

To be completely transparent about how tools were used:
- **AI Usage**: I used AI tools as a fast typing assistant and junior pair programmer—specifically for generating initial boilerplate scaffolding for Sequelize migrations, formulating TypeScript error classes, and brainstorming edge-case test combinations (like micro-decimal precision tests).
- **Engineering Ownership**: Every single architectural decision—choosing pessimistic row locks over OCC, structuring the append-only ledger alongside cached balances, establishing the global lock hierarchy to kill deadlocks, formulating the hostile PSP amount mismatch policy, and designing the Part B adapter—reflects my own engineering judgment. I understand every line, own every design trade-off, and look forward to defending them in the technical interview.

---

## 7. Production Roadmap: What I Would Build Next

If this were going into production next week with dedicated team capacity, here is what I would prioritize:

### 1. Transactional Outbox Pattern
Currently, when a deposit or wager completes, we only write to PostgreSQL. To notify downstream services (risk scoring, marketing bonuses, CRM, analytics) without risking dual-write inconsistencies, I would add an `outbox_events` table written inside the same database transaction. A Debezium CDC worker or background poller can publish those events reliably to Apache Kafka or RabbitMQ.

### 2. Automated Daily Reconciliation Cron
While our ledger reconstructibility tests prove math correctness, production databases face human interventions, direct DB patches, and unexpected third-party bugs. I would build a scheduled background cron running at 4:00 AM UTC that queries:
```sql
SELECT w.id, w.balance, COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0) AS ledger_sum
FROM wallets w
LEFT JOIN wallet_txs l ON l.wallet_id = w.id
GROUP BY w.id, w.balance
HAVING w.balance != COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END), 0);
```
Any mismatch would immediately trigger a high-severity alert to on-call engineering before any player notices.

### 3. Campaign-Specific Turnover Bucketing
Currently, turnover counters are scalar running totals on the wallet. In a mature casino/sportsbook product, bonuses are campaign-specific (e.g., "50% Welcome Bonus with 5x turnover expiring in 14 days" vs "VIP Cashback with 1x turnover expiring in 48 hours"). I would introduce a `wallet_turnover_buckets` model that tracks expiration dates, priority ordering (cash spent before bonus money), and game contribution percentages (slots 100%, blackjack 10%).
