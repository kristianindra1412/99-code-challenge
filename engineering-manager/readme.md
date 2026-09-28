# Engineering Manager / Senior Manager - Take-Home Challenge

**Time budget: ~4 hours** across three parts (A ≈ 2h, B ≈ 1h, C ≈ 1h). We respect your time - depth of judgment beats volume of prose, and every part has a hard page/word limit.

All three parts share one scenario. Read the handover pack first.

---

## The scenario

You have just joined as Engineering Manager, taking over the engineering org of a **regulated, real-money transactional platform** (think wallets, deposits through third-party payment providers, withdrawals - money correctness is existential). The platform runs as one deployment per region; three regions are live, serving ~30 client brands. Your predecessor left two weeks ago; the handover pack below is what you got.

### Handover pack

**Org - 20 engineers + 2 QA, three squads:**

| Squad | Size | Owns | Notes from predecessor |
|---|---|---|---|
| Payments & Platform | 7 BE | Wallets, payment integrations, core platform | "S. is staff-level and the only person who truly understands the wallet engine. Brilliant, but his reviews make juniors cry. D. and two others are solid mids. Three juniors < 1 yr." |
| CRM & Data | 5 (4 BE, 1 data) | Central CRM, cross-region reporting, data pipeline | "Newest squad. Tech lead T. is great but stretched - also on-call for pipeline. Backlog growing." |
| Web & Backoffice | 6 FE | Player-facing web, internal back office | "Stable. Lead L. is your most experienced people-manager; has quietly been mentoring juniors from other squads." |
| QA | 2 | Manual + E2E automation | "Bottleneck before every release." |

Two open BE headcount, unfilled for 3 months.

**Incidents - last 90 days (summarized):**

| # | What happened | Impact | Root cause |
|---|---|---|---|
| 1 | Duplicate payment-provider callback credited a deposit twice | Money loss, clawed back manually | Missing idempotency guard |
| 2 | Withdrawal batch stuck 6h, players blocked | Player-facing, support flooded | DB connection pool exhausted by batch job |
| 3 | Region-2 launch: 6h full outage on launch day | Launch delayed a week | Config copied from region 1 with wrong provider credentials |
| 4 | Wrong rounding on currency conversion for one brand | Money (small), regulatory report amended | Float arithmetic in a report job |
| 5-9 | Five smaller incidents | Various | 3 of 5 trace back to changes in payment-adjacent code that passed review |
| 10-11 | Two data-pipeline stalls | Internal reporting late | Single point of knowledge (T.) was on leave |

MTTR is trending up. There is no formal incident process; whoever notices, fixes.

**Delivery:**

- Release cadence has slipped from weekly to roughly bi-weekly; releases regularly slip because QA finds regressions late.
- The region-3 launch took **4 months** against a 6-week plan. Post-mortem never happened.
- Bug backlog: +30% quarter over quarter.
- No delivery metrics exist beyond a burndown chart nobody trusts.

**Business commitments for next quarter (non-negotiable, from the CEO):**

1. **Launch region 4 in 10 weeks.** New market, new local payment providers, some regulatory differences.
2. **Money-impacting incidents to zero.** The board saw incident #1.

---

## Part A - Your 90-day plan (max 3 pages)

Write the plan you would actually execute. It must cover:

1. **Diagnosis** - what is actually wrong here? Use the data above; we are looking for root patterns, not a restatement of the tables.
2. **Priorities and trade-offs** - you cannot fix everything while launching region 4. What do you do, in what order, and explicitly: what do you *not* do this quarter?
3. **Process changes** - concrete and few. For each: what problem it attacks and how you'll know it's working.
4. **Metrics** - what you will measure to know the org is getting healthier. Justify each; no dashboard shopping lists.
5. **People** - using the roster: who needs what from you (coaching, scope change, protection, challenge), and what you do about the two open headcounts and the QA bottleneck.

Format is yours. Bullet points welcome. Page limit is enforced - we stop reading at page 3.

## Part B - The PR (max 1 page of review + ½ page answer)

It's day 9. Tomorrow morning the Payments squad merges **PR #482** (see `pr-under-review/` - description + full diff) into the payout flow. S., the staff engineer, has already approved it. You have 30 minutes before your next meeting and decide to look.

1. **Write your review** exactly as you would post it on the PR - verbatim comments, in the order/priority you'd post them. If you would block the merge, say so and say why; if not, say why not.
2. **The conversation:** S. approved this. Whatever you found (or didn't), how do you handle it with S. and with D., the author - and what, if anything, do you change so this class of problem doesn't reach you personally next time?

## Part C - Two situations (max 300 words each)

**C1.** Saturday, 01:40. Support escalates: several players in region 2 report balances higher than they should be. Numbers are still moving. The CEO has seen the support thread and messages you directly: *"are we losing money right now?"* Walk through your first 24 hours - decisions, comms, and who does what. Assume S. is reachable, T. is on leave, and you personally do not know this part of the codebase.

**C2.** Week 6. In sprint planning, in front of both squads, L. - your strongest lead and the person everyone respects most - says your 90-day plan is "process theater that will slow us down while we're supposed to be launching region 4," and suggests the squads just ignore the new release checklist. The room goes quiet and looks at you. What do you do in the next 60 seconds, and what do you do after?

---

## Deliverables

One PDF or Markdown file containing Parts A, B, C - plus a short `NOTES.md` if you want to flag assumptions.

## Rules

- **AI tools are allowed.** Disclose what you used them for at the end of your submission. You own every recommendation - the first interview digs into your reasoning, and answers you cannot defend are failing answers.
- Invented context is fine where the pack is silent - state your assumptions inline.
- Hard limits are real: 3 pages / 1 page / 300 words. Editing is part of the exercise.
