import { Channel, ConsumeMessage } from 'amqplib';
import { Types } from 'mongoose';
import { getChannel, POINTS_CREDIT_QUEUE } from './connection';
import { OrderPaymentSucceededEvent } from './producer';
import { Order } from '../models/Order';
import { User } from '../models/User';
import { TierConfig } from '../models/TierConfig';
import { ProcessedCredit } from '../models/ProcessedCredit';

// Placeholder points rule: 1 point per unit of currency spent on a line item.
// Not specified in the brief yet — easy to swap out for a real rule later.
const POINTS_PER_CURRENCY_UNIT = 1;

// Debug-only: artificially slow down each credit so the "second order beats
// the first order's queue processing" race is wide enough to reproduce by
// hand (place order 1, then place order 2 from another tab within the
// delay window). Leave at 0 for normal use/recording.
const PROCESSING_DELAY_MS = Number(process.env.CONSUMER_PROCESSING_DELAY_MS ?? 0);
if (PROCESSING_DELAY_MS > 0) {
  console.log(`[consumer] CONSUMER_PROCESSING_DELAY_MS active: ${PROCESSING_DELAY_MS}ms per credit`);
}

// Exported so the /orders route can run this same idempotent operation
// inline — see creditPendingOrdersForUser in routes/orders.ts. Whichever of
// the two (this consumer, or an inline catch-up) reaches a given item first
// does the real work; the dedup insert below makes the other a no-op.
//
// `skipDebugDelay`: the artificial delay only ever exists to simulate the
// *background consumer* being slow/backlogged. The inline catch-up path
// must stay fast regardless — that speed is the actual point being
// demonstrated — so it opts out of the delay explicitly.
export async function creditItem(
  orderId: string,
  userId: string,
  itemId: string,
  opts?: { skipDebugDelay?: boolean }
): Promise<void> {
  if (PROCESSING_DELAY_MS > 0 && !opts?.skipDebugDelay) {
    await new Promise((resolve) => setTimeout(resolve, PROCESSING_DELAY_MS));
  }

  const order = await Order.findById(orderId);
  if (!order) {
    console.warn(`[consumer] order ${orderId} not found, skipping item ${itemId}`);
    return;
  }

  const item = order.items.id(itemId);
  if (!item) {
    console.warn(`[consumer] item ${itemId} not found on order ${orderId}, skipping`);
    return;
  }

  const pointsCredited = Math.round(item.price * item.qty * POINTS_PER_CURRENCY_UNIT);

  try {
    // The unique index on orderItemId is what actually enforces idempotency;
    // this insert is the dedup check.
    await ProcessedCredit.create({ orderItemId: itemId, orderId, userId, pointsCredited });
  } catch (err: any) {
    if (err?.code === 11000) {
      console.log(`[consumer] item ${itemId} already credited, skipping (dedup)`);
      return;
    }
    throw err;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { 'loyalty.points': pointsCredited } },
    { new: true }
  );
  if (!user) {
    console.warn(`[consumer] user ${userId} not found while crediting item ${itemId}`);
    return;
  }

  await applyTierProgression(user._id);
}

// Grants a benefit for every tier newly qualified for, not just the top one —
// so a big single order that jumps two tiers at once doesn't skip a benefit.
//
// Takes a userId and re-reads fresh each attempt, rather than trusting a
// caller-supplied user snapshot — a snapshot can go stale across the
// TierConfig.find() await below if another call (the async consumer vs. the
// inline catch-up in routes/orders.ts can both be mid-flight for the same
// user at once) commits its own tier/benefit change in the meantime.
//
// Bounded retry (max 3 attempts): the compare-and-swap update below can lose
// to a concurrent call even when this call read the more up-to-date state —
// write order isn't guaranteed to match read order. A single CAS-and-give-up
// would silently drop a legitimately-earned tier in that case. Retrying with
// a fresh read closes that gap; giving up after 3 attempts (rather than
// looping forever) accepts that this is best-effort — points are already
// credited regardless, and tier/benefits will self-heal the next time this
// user is credited again.
async function applyTierProgression(userId: Types.ObjectId): Promise<void> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const user = await User.findById(userId);
    if (!user) return;

    const tiers = await TierConfig.find().sort({ minPoints: 1 });
    const qualifying = tiers.filter((tier) => tier.minPoints <= user.loyalty.points);
    const currentIndex = qualifying.findIndex((tier) => tier.name === user.loyalty.tier);
    const newlyReached = qualifying.slice(currentIndex + 1);

    if (newlyReached.length === 0) return;

    const newBenefits = newlyReached.map((tier) => ({
      type: tier.benefit.type,
      value: tier.benefit.value,
      catalogId: tier.benefit.catalogId,
      description: tier.benefit.description,
      earnedFromTier: tier.name,
      status: 'available' as const,
      grantedAt: new Date(),
    }));

    const topTier = newlyReached[newlyReached.length - 1];

    // Compare-and-swap: only apply if the tier is still what we just read it
    // as. `?? null`, not the bare (possibly undefined) value — an explicit
    // null avoids relying on how the driver serializes an undefined filter
    // value, which is exactly the ambiguity a brand-new user's first tier
    // crossing (tier not yet set) would otherwise hit.
    const result = await User.updateOne(
      { _id: userId, 'loyalty.tier': user.loyalty.tier ?? null },
      {
        $push: { benefits: { $each: newBenefits } },
        $set: {
          'loyalty.tier': topTier.name,
          'loyalty.tierUpdatedAt': new Date(),
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[consumer] user ${user._id} reached tier(s): ${newlyReached.map((t) => t.name).join(', ')}`);
      return;
    }

    // Lost the race — another concurrent call moved the tier in between our
    // read and our write. Loop back and retry against fresh state.
  }

  console.warn(
    `[consumer] applyTierProgression: gave up after ${MAX_ATTEMPTS} attempts for user ${userId} — ` +
      'tier/benefits update lost the race each time; will self-heal on the next credit for this user'
  );
}

async function handleMessage(channel: Channel, msg: ConsumeMessage | null): Promise<void> {
  if (!msg) return;

  try {
    const event: OrderPaymentSucceededEvent = JSON.parse(msg.content.toString());
    for (const itemId of event.itemIds) {
      await creditItem(event.orderId, event.userId, itemId);
    }
    channel.ack(msg);
  } catch (err) {
    console.error('[consumer] failed to process message, dropping (no requeue)', err);
    // No dead-letter queue for this demo — a poison message is dropped
    // rather than requeued forever.
    channel.nack(msg, false, false);
  }
}

export async function startLoyaltyConsumer(): Promise<void> {
  const channel = await getChannel();
  // prefetch(1) serializes processing — simplest way to avoid two in-flight
  // messages racing on the same user's points/tier update in this demo.
  await channel.prefetch(1);

  await channel.consume(POINTS_CREDIT_QUEUE, (msg) => handleMessage(channel, msg), { noAck: false });
  console.log(`[consumer] listening on "${POINTS_CREDIT_QUEUE}"`);
}
