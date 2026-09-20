# Progression History

I haven't pushed incrementally as I went, so this doc exists to make that progression visible a different way: the design questions I ran into, the options I weighed, and why I landed where I did. It's written chronologically, grouped by milestone rather than by commit. I built this alongside an AI pair-programmer (Claude Code) — the ideas, trade-offs, and final calls below are mine, arrived at through that back-and-forth, and I've tried to keep the reasoning honest rather than tidied up in hindsight.

## 1. Stack and scope

Before writing any code I fixed the stack deliberately, not by default:

- **Node.js + Express + TypeScript**, not NestJS. I'm not familiar with Nest, and pulling in a framework I'd be learning *and* leaning on at the same time felt like the wrong trade for a timed assessment.
- **MongoDB + Mongoose.** New to me — my prior database experience is Postgres/Supabase. I chose Mongo specifically to learn it, not because it's the "right" fit for this domain (arguably a relational schema with foreign keys would model users/orders/tiers just as naturally, if not more so).
- **RabbitMQ.** Also a deliberate choice for the experience of owning a real message broker end to end — exchange/queue topology, ack/nack semantics, consumer behavior — rather than reaching for something that abstracts that away.
- **React frontend, kept minimal.** The assessment is about the backend/loyalty logic; the UI exists to exercise and demonstrate that logic, not to be a polished product.
- **Docker Compose for local Mongo + RabbitMQ only.** No cloud deployment, CI/CD, or infra-as-code — the deliverable is a working local demo plus a short recording, not a production system.

## 2. Schema design

The core entities are `User`, `Order`, and `tier_configs`, plus a `ProcessedCredit` collection added once idempotency became a concern (see §3).

**`tier_configs` as one document per tier**, rather than a single static config object or a hardcoded array in code. This makes thresholds and benefits *data* — inspectable and changeable without a deploy — and it's also what let me later restructure the entire tier ladder (§4) as a data change, not a code change.

**Order line items: `catalogId` vs. `_id`.** Initially an order item only had a reference back to the catalog. I added a second, purchase-scoped `_id` on each line item so that the RabbitMQ event and the idempotency/dedup logic (§3) have something to key on that uniquely identifies *this specific purchase of this item*, distinct from "which catalog item is this." Without that split, crediting logic would have no clean way to refer to "line item 2 of order X" independent of what product it happens to be.

## 3. Domain models and the RabbitMQ pipeline

With the schema settled, I built `User`/`Order`/`tier_configs`/`ProcessedCredit`, then the producer/consumer pair.

**Exchange topology:** a topic exchange (`loyalty`) with a durable queue (`loyalty.points_credit`), bound on routing key `order.payment.succeeded`. Topic over direct/fanout because it leaves room to add more granular routing keys later (e.g. per event type) without restructuring the exchange.

**Idempotent crediting — insert-and-catch, not check-then-insert.** The consumer credits points per order line item. The naive approach — check if a credit already exists, then insert if not — has a race window between the check and the insert. Instead, `ProcessedCredit` has a **unique index on `orderItemId`**, and the consumer just attempts an insert; a duplicate-key error (Mongo error code `11000`) means "already credited, no-op." This makes the operation safe to run twice, which matters a lot once the same crediting logic is also called from a second code path (§7).

**`prefetch(1)` / competing consumers.** The consumer processes one message at a time per connection, which was the simplest way to avoid two in-flight credits racing on the same user's points update within a single consumer. I also ran into — and had to account for while testing — the fact that if I run a second isolated backend instance against the same RabbitMQ, both register as consumers on the same queue and messages get split between them nondeterministically. Not a bug, just something to be aware of when testing with multiple running instances.

**No dead-letter queue.** A message that fails processing is dropped (`nack` without requeue) rather than retried indefinitely. A deliberate simplification for this scope — noted as a gap, not an oversight.

## 4. Frontend scaffolding and benefit UX — three iterations

The frontend went through real iteration rather than being designed once and built:

1. **First pass:** benefits auto-applied with no user control, discount types kept simple.
2. **Then:** switched to an explicit "Apply" button, one-time use per benefit — this felt more honest about what's actually happening (a benefit doesn't silently vanish into a discount the user didn't ask for), and matched a real loyalty-program mental model where a customer chooses when to redeem something.
3. **Then, back to auto-apply — but with an opt-out**, defaulting on. This came out of the race-condition discussion in §7: once orders can complete "ahead of schedule" via the inline catch-up fix, the newly-unlocked benefit may not have rendered in the UI yet for the user to manually click. Auto-apply-by-default means the user still gets the benefit they qualified for even if they never saw it appear in time; the opt-out preserves the ability to deliberately *not* redeem something (e.g. saving it for a larger order).

Other UX decisions along the way:
- Applying a "free N of item X" benefit auto-sets that item's cart quantity to N, so the free items are visibly part of the order rather than an abstract discount unrelated to the cart's actual contents.
- A live "after benefit" price preview was added so the user can see the effect of a benefit before placing the order — e.g. with 5 free Lunch Combos applied, seeing the total jump the moment a 6th is added.
- The tier/points panel polls the backend every 1.5s while a user is selected, since crediting happens asynchronously off the queue and I wanted the UI to reflect that without a manual refresh — a deliberately low-tech substitute for the WebSocket-push approach discussed and rejected in §7.
- Most recently: split the single-screen dashboard into a **login gate** (select or create a user, explicit "Login" button with validation that a user is actually selected) and the **rest of the dashboard** (loyalty status, catalog, checkout), which only renders after login. This mirrors a real app's session boundary more explicitly than the original single-panel layout did.

## 5. Tier ladder and pricing restructuring

After the initial flow was working end to end, I reworked the numbers for a tighter demo:

- Bronze $100 → 5% discount
- Silver $200 → 10% discount
- Gold $300 → free delivery
- Platinum $400 → 5 free Lunch Combos

And added a **flat $10 delivery fee that is explicitly excluded from loyalty points** — points are earned on item subtotal only. This was a deliberate business-logic decision (delivery isn't "spend" in the loyalty sense) and meant threading a separate `deliveryFee` field through the order model and pricing calculation, kept apart from the discountable items subtotal.

Because `tier_configs` is one document per tier (§2), this whole restructuring — including changing what platinum grants — was a data change via a seed script, not a schema or logic change.

I also explicitly re-confirmed (rather than assumed) one behavior: a brand-new account has *no tier* until their first credited purchase, rather than starting at bronze by default. Kept as-is after weighing it — it matches "you haven't earned anything yet" more honestly than defaulting everyone into the bottom tier for free.

## 6. The race condition: same user, two in-flight orders

This was the most substantial design discussion of the project.

**The scenario:** a user has their account open in two places (two tabs, two devices). They place an order that pushes them into a new tier. Before the async consumer has processed that credit, they place a *second* order — one that should be eligible for the benefit they just earned, or whose tier math depends on the first order's points already being counted.

**Why it's plausible, not just theoretical:** I initially explored this from a "long queue backlog" angle — could enough concurrent users create a queue deep enough that a fast repeat action beats the queue? Worth considering, but the actual failure mode doesn't need a busy system at all: it's a same-user race on *any* system, because there's no synchronization between "payment succeeded" and "this specific user's next request" — the queue is decoupled from the request path by design. Two browser tabs are enough to hit it locally, no load required.

**Approaches considered and rejected:**

- **A priority queue for repeat customers** — I asked directly whether this was effectively what was being proposed. It isn't the right frame: this isn't about *prioritizing* a user's second order ahead of others in a shared queue, it's about a single user's *own* two requests being causally ordered relative to each other. A priority lane wouldn't fix that.
- **Session-aware WebSocket push** — my own idea: detect a user's active sessions, and when a purchase succeeds that would cross a tier threshold, push an alert to their other open sessions so the UI can wait for the real credit before proceeding, with a pre-check so this only happens for purchases that actually matter for tier movement. I still think this is the *architecturally correct* answer for a real product. I deliberately didn't build it here: WebSockets/session management would have added a meaningful new skill surface on top of everything else in this assessment, and it's not something I'd be able to defend as deeply as the rest of the implementation. I'm noting it here explicitly as the acknowledged "right" solution I chose not to build, rather than one I didn't consider.

**What I actually built: inline catch-up.** Before pricing any new order, the request handler first checks whether this *same user* has any of their own earlier `paid` orders whose line items haven't been credited yet (via the same unique-index dedup check from §3), and if so, credits them synchronously, inline, before proceeding. This reuses the exact same idempotent `creditItem` function the async consumer calls — whichever of the two (background consumer, or this inline catch-up) reaches a given line item first does the real work, and the unique index makes the other one a safe no-op.

I want to be precise about what this does and doesn't solve: it doesn't make the *other browser tab* aware that a benefit was just unlocked (that's the WebSocket gap above), but it guarantees that **pricing is always correct** — the moment the user's *next* request hits the server, any of their own outstanding credits are settled first, so tier and benefit eligibility used for that request's pricing can never be stale. The blame, as discussed, is left on the UI potentially lagging behind — not on the numbers being wrong.

## 7. Building and debugging the fix

To make the race reproducible on demand for testing and recording (rather than relying on winning a real timing race by hand), I added a debug-only `CONSUMER_PROCESSING_DELAY_MS` env var that artificially slows the consumer's per-item processing.

Two real bugs turned up while building and testing this, both caught through my own manual testing rather than being anticipated up front:

- **The debug delay leaked into the catch-up path.** The inline catch-up call and the background consumer both went through the same `creditItem` function, which meant the artificial delay — meant only to simulate a *slow background consumer* — was also slowing down the catch-up path that's supposed to demonstrate being fast. Fixed with an explicit `skipDebugDelay` option so the catch-up call opts out of the delay while the real consumer keeps it.
- **A RabbitMQ consumer leak in the `/health` endpoint.** Each health check registered a new consumer on a health-check queue without ever canceling it, so repeated health checks left a growing number of dangling consumers — confirmed by watching the consumer count climb via the RabbitMQ management API. Fixed by capturing the consumer tag and explicitly canceling it after each check, on both the success and timeout paths.

**Testing technique worth noting:** once I had two backend instances (mine for isolated testing, the live one for the demo) both registered on the same shared queue, timing-based tests became nondeterministic — I couldn't tell if a result was "the fix working" or "the other consumer got the message first." I moved to a deterministic technique instead: inserting an already-`paid` order directly into MongoDB via `mongosh`, bypassing the queue entirely, so there's no consumer race to confound the test of the *request-path* logic specifically.

## 8. Publisher confirms — the broker-unreachable gap

After the flow above was working, I realized there was a gap I hadn't actually tested for: `channel.publish()` on a plain AMQP channel is fire-and-forget. It only confirms the message was handed off from this process to the socket — not that RabbitMQ ever received or accepted it. If the broker were unreachable, or refused the message (e.g. a resource limit on the queue), `publish` would still return normally. In the order route as it stood, that meant: the order gets saved as `paid`, the benefit gets marked `used`, the response tells the user their order succeeded — and the event that would have credited their loyalty points simply vanishes, with nothing anywhere flagging that it happened. The order is correct; the loyalty side of it silently isn't.

**The fix: publisher confirms.** `queue/connection.ts` now opens a confirm channel (`connection.createConfirmChannel()`) instead of a plain one (`connection.createChannel()`) — the same shared channel used by the producer, consumer, and health check, since a confirm channel is a strict superset of a plain one (everything that worked before still works). In `queue/producer.ts`, `publishOrderPaymentSucceeded` now uses the callback form of `channel.publish(...)`, wrapped in a `Promise`, and `await`s it — so the function doesn't resolve until RabbitMQ has actually acknowledged the message, and rejects if the broker nacks it or the connection drops before an ack comes back.

That rejection needed somewhere honest to go. I added a dedicated `catch` around the publish call in the `/orders` route: since the order is already durably saved as `paid` by that point, a publish failure isn't a request failure (not a `500`) — it's still a `201`, but with a message that says plainly that loyalty crediting could not be queued and points were not credited for this order, rather than the same success message used for the normal path. The alternative — folding it into the route's generic catch-all, which returns a bare `500` — would have been worse: it would suggest the order itself failed when it didn't, which is its own kind of dishonesty about what actually happened.

This is deliberately the minimal fix (confirm channel + promise-wrapped publish + an honest response on failure), not a full outbox/retry pattern — there's still no automatic retry or reconciliation job that would pick this order back up and re-publish it later. That's a reasonable next step, not something this scope needed to solve.

## 9. Benefit consumption wasn't atomic either

Once the broker-unreachable gap in §8 was closed, I went looking for the same shape of problem elsewhere and found one: benefit *consumption* had the identical read-then-write race as the publish path, just on a different document.

The old flow read `user.benefits` into memory, found an `available` benefit, priced the order against it, and — only after the mock payment "succeeded" — flipped `benefit.status = 'used'` on that in-memory subdocument and called `user.save()`. That save is not a compare-and-swap: it doesn't check that the benefit was still `available` at the moment of the write. So two concurrent requests for the *same account* — e.g. the same login open on two devices, both checking out within a moment of each other, both reading the same benefit as available before either has saved — can each independently mark it used, each pointing at a different order. A one-time benefit gets spent twice, and both orders come out discounted.

**The fix, using the compare-and-swap pattern I'd been pointed at — first draft:**

```js
const result = await User.findOneAndUpdate(
  { _id: user._id, 'benefits._id': benefit._id, 'benefits.status': 'available' },
  { $set: { 'benefits.$.status': 'used', 'benefits.$.usedOnOrderId': order._id } },
  { new: true }
);
if (!result) {
  // someone else got it first; abort order or retry without benefit
}
```

The intent: the filter's `'benefits.status': 'available'` should mean the update only matches — and only succeeds — if the benefit is still available at the exact instant Mongo processes the write. Whichever concurrent request's write lands first flips the status; the other's filter no longer matches anything and it gets `null` back.

**This had a bug, caught in review before it shipped: two top-level `'benefits._id'`/`'benefits.status'` conditions don't mean "the same array element has both."** That's MongoDB's documented behavior for querying an array of subdocuments with multiple dot-path conditions and no `$elemMatch` — each condition can be satisfied by a *different* element of the array. Since `_id` is unique, `'benefits._id': X` always pins to exactly one element, but `'benefits.status': 'available'` can be satisfied by any *other* available benefit the user happens to have. So if benefit X was already claimed by a concurrent request, but the user had some unrelated benefit Y still available, the filter would spuriously match anyway (X satisfies the `_id` condition, Y satisfies the `status` condition) — and the positional `$` in the update, given two conditions that matched two different indices, is then ambiguous about which element it actually touches. That's not "the race isn't prevented," that's a real risk of silently flipping the *wrong, unrelated* benefit to `'used'`.

**Fixed with `$elemMatch`**, which forces both conditions onto the same array element — and gives the positional `$` in the update an unambiguous single match to act on:

```js
const claimed = await User.findOneAndUpdate(
  {
    _id: user._id,
    benefits: { $elemMatch: { _id: benefitCandidate._id, status: 'available' } },
  },
  { $set: { 'benefits.$.status': 'used', 'benefits.$.usedOnOrderId': orderId } },
  { new: true }
);
```

Worth keeping visible rather than editing away: the first version of this fix — meant to close a correctness gap — introduced a subtler one of the same shape, in the same query, on the very next line. The lesson wasn't really about `$elemMatch` specifically; it's that "add a filter condition on an array field" is not automatically "match this specific element," and that's easy to miss even while actively thinking about races.

**Where I placed it, and why that placement matters as much as the query itself:** it would have been easy to just swap the old `user.save()` for this atomic version *in the same spot* — right after mock payment succeeds — and call it done. I didn't, because that spot is too late: pricing and the mock "payment" both already happened by then, computed against a benefit that hadn't actually been claimed yet. If the atomic claim were attempted there and lost, I'd be stuck with an order already priced and "paid" using a discount that turned out to belong to someone else's request. So the claim now happens *before* pricing — right after picking which benefit to try, and before the order or its total exist at all. That also meant pre-generating the order's `_id` (`new Types.ObjectId()`) so it can be written into `usedOnOrderId` as part of the same atomic update, since the `Order` document itself doesn't exist yet at that point.

**Handling a lost race**, per the two options in the snippet's comment:
- An **explicit** `benefitId` (the user clicked "Apply" on something specific) that loses the race now returns a `409` — the caller asked for a specific benefit that turned out to already be spent by the time the claim ran, and pricing the order without saying anything would be misleading.
- An **auto-applied** benefit that loses the race just falls through and prices the order with none — auto-apply was already "use whatever's best-effort available," so silently proceeding without it is consistent with what auto-apply already means, not a new failure mode.

**One thing this changes had to preserve:** the existing rule that a *failed* mock payment leaves the benefit available for a retry. Since the benefit is now claimed *before* the payment step (not after, like before), a failed payment has to explicitly release the claim back to `available` — a small extra `updateOne` in the failure branch — rather than simply never having consumed it in the first place.

## 10. Tier progression had the same shape of bug, in `applyTierProgression`

Same pattern again, third time: `applyTierProgression` (in `queue/consumer.ts`) took an already-loaded `user` document, read `points`/`tier` off it, awaited `TierConfig.find()` (a real gap where another call can interleave), then pushed benefits and `$set` the tier via a plain `user.save()`. The async consumer and the inline catch-up (§6) both call the same `creditItem` → `applyTierProgression` path, and they're genuinely concurrent — separate call stacks (a background queue message handler vs. a synchronous HTTP request) that can each be mid-flight for the *same user* at once, crediting *different* line items. That's not a hypothetical; it's exactly the scenario this whole inline-catch-up design exists to handle.

**The proposed diagnosis needed a correction before I trusted it.** It was framed as "`user.save()` rewrites the entire document, so a stale save erases points credited elsewhere in the meantime." That's not how Mongoose's `save()` actually behaves — it sends a delta update of only the paths that were actually mutated on that in-memory document (plus tracked array ops like `.push()`), not a full-document overwrite. `loyalty.points` is never reassigned inside `applyTierProgression` — it's only ever changed via a separate atomic `$inc` — so it's never "dirty," and a stale `save()` here was never going to touch it. Points were never actually at risk. The real bug was narrower but still genuine: a stale snapshot's `tier`/`benefits` fields getting unconditionally written back, capable of *regressing* an already-more-advanced tier that a concurrent call had committed in the meantime, or double-granting the same benefit.

**Fix:** `applyTierProgression` now takes a `userId`, not a `user` document, and does its own fresh `User.findById` at the top rather than trusting whatever the caller happened to have in hand. The final write is a single atomic `User.updateOne` with a compare-and-swap filter — `{ _id: userId, 'loyalty.tier': user.loyalty.tier }` — combined with `$push: { benefits: { $each: newBenefits } }` and `$set` for the new tier. If another call already moved the tier past what this call read, the filter no longer matches and the update silently no-ops instead of clobbering the newer state.

**This closed the original problem but not the whole race — a CAS-and-give-up with no retry means "no-op" isn't always the safe outcome it sounds like.** It assumes whichever call's *write* lands second must be the one with the *less* up-to-date read, so dropping it is safe. That's not guaranteed: read-timing and write-timing are independent, so a call that read a more current (higher) points value can still lose the write race to a call that read an older one. Concretely: two items credited close together — one alone would reach bronze, the two together reach silver — could end up with the call that computed `[bronze, silver]` losing the CAS to the call that only computed `[bronze]`, and silver never getting granted at all. Arguably worse than the bug being fixed: the old code's failure mode was *double-granting* a benefit (annoying, generous); the no-retry CAS's failure mode was *silently dropping an earned one*.

**Fix: a bounded retry (max 3 attempts).** On `modifiedCount === 0` (the CAS lost), re-read the user and recompute `newlyReached` from scratch against current state, rather than giving up after one shot. This closes the actual gap — a call that lost the race simply tries again against whatever the winner just committed, and on the retry either finds there's nothing left to do (the winning call already covered its tiers too) or computes the smaller remaining delta and claims that instead. After 3 failed attempts it logs a warning and returns without throwing — points are already credited regardless of any of this (that part was always atomic and unaffected), so worst case is a tier/benefit lagging by one credit cycle rather than data loss; it self-heals the next time this user is credited again, since the next call's fresh read will pick up wherever things actually stand.

**The `undefined`-tier CAS question got resolved as part of this pass, not left open:** the filter now explicitly does `'loyalty.tier': user.loyalty.tier ?? null` rather than passing the bare value through. `null` is unambiguous — Mongo natively treats a `{field: null}` query as matching both an explicit `null` and a missing field — so a brand-new user's first tier crossing (no `tier` set yet) is no longer dependent on how a particular driver version happens to serialize `undefined`. Turning "note this as untested and driver-dependent" into "make it not depend on driver behavior at all" was the better fix once it was flagged, rather than shipping the ambiguity and hoping.

## 11. What happens when the broker just isn't there anymore

Everything up to this point assumed RabbitMQ stays reachable once the app connects to it. It doesn't have to — a broker restart, a container crash, a network blip — and I hadn't looked at what happens then. `queue/connection.ts` opens one connection and one confirm channel and caches them in module-level variables for the whole app's lifetime. If the underlying connection drops, those cached variables don't know that — they just keep being dead handles. Every subsequent publish would throw or hang, every consume would receive nothing, and none of it would be logged anywhere: the app would silently stop doing its job with no signal that anything was wrong. For a queue-driven flow where "loyalty points get credited" already happens invisibly to the user (§4's whole reason for polling the UI), a silently-dead consumer is a particularly bad failure mode — nothing would look broken until someone noticed points just... stopped arriving.

**The fix is deliberately not a fix that keeps the app running — it's making the failure loud instead of silent.** `getChannel()` now registers `connection.on('error', ...)` and `connection.on('close', ...)` right after connecting, and `channel.on('error', ...)` right after the channel is created. The `error` handlers just log. The `close` handler on the connection does more: it logs a clear message and calls `process.exit(1)`.

That's a real design choice, not a shortcut I'm glossing over: **amqplib doesn't reconnect on its own**, and this module's cache-in-a-module-variable pattern means there's no natural place to recover into even if it did — the exchange/queue/binding assertions and the consumer registration all happened once, at startup, against the now-dead connection. Actually reconnecting properly would mean a library like `amqp-connection-manager`, or a hand-rolled reconnect-with-backoff that re-establishes the connection, re-asserts the exchange/queue/binding, and re-registers the consumer once the broker comes back — none of which this demo needed to build. Given the actual choice at hand — silently hang forever, or crash with a message telling the operator exactly what happened and that a restart will fix it — crashing is the more honest option for an environment where I'm the one watching the terminal. This is the same instinct as §3's "no dead-letter queue" and §6's "leave the blame on the UI, not fake sync" — pick the simple, legible failure mode over a more complete one I can't fully build and verify in scope, and say so explicitly rather than let the gap masquerade as handled.

Verified by restarting the broker mid-run (`docker compose restart rabbitmq`) with the backend up: the process logs `[rabbitmq] connection closed — exiting so the process can be restarted` and exits, rather than continuing to accept requests that would then hang or fail without explanation.

One narrower gap left in deliberately, not missed: `channel.on('error', ...)` only logs, it doesn't exit. A channel-level protocol error (distinct from the whole connection dropping) closes just that channel while the connection itself can stay alive — in principle that could leave the app with a dead channel and a live connection, so no `close` event fires and the process keeps running. I scoped this pass to the connection-loss case specifically (broker restarts, network blips — the realistic failure modes for a local demo), not every conceivable amqplib channel-level exception; noting it here rather than pretending the channel handler is a complete answer to "any queue failure."

## 12. Where this leaves things

What's demonstrated end to end: place order → benefit atomically claimed (if any) before pricing → mock payment → event published (with a broker acknowledgment, not just a fire-and-forget write) → idempotent async credit → tier re-evaluation (compare-and-swap with bounded retry) → benefit granted → benefit applied (auto or manual, race-safe) at a later checkout — including the same-user queue-timing race (§6), the same-user concurrent-checkout race (§9), and concurrent tier progression (§10) — the broker-unreachable-at-publish-time case (§8) reported honestly rather than silently, and the broker-disappears-entirely case (§11) failing loudly instead of hanging invisibly.

What I'd build next with more time, in rough priority order: real reconnect logic (§11) instead of exit-and-restart, for an environment where restarting isn't the operator's job; the WebSocket/session-push layer described in §6 to close the UI-lag gap (not the pricing gap, which is already closed); an outbox/retry mechanism so a publish failure isn't just reported but eventually self-heals; a dead-letter queue instead of dropping failed consumer messages; and a real auth/session layer in place of the demo's simple user picker.
