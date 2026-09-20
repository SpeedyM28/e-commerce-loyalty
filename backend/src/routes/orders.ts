import { Router } from 'express';
import { Types } from 'mongoose';
import { Order, IOrder } from '../models/Order';
import { User } from '../models/User';
import { ProcessedCredit } from '../models/ProcessedCredit';
import { publishOrderPaymentSucceeded } from '../queue/producer';
import { creditItem } from '../queue/consumer';
import { CATALOG_PRICE_BY_ID } from './catalog';
import { DELIVERY_FEE } from '../constants';

const router = Router();

interface OrderItemInput {
  catalogId: string;
  name: string;
  price: number;
  qty: number;
}

// Inline catch-up for the "second order beats the first order's queue
// processing" race: before pricing a new order, credit any of this user's
// own earlier paid orders that the background consumer hasn't gotten to yet.
// Reuses the exact same idempotent creditItem the consumer calls — see the
// design discussion this came out of. Scoped to this one user's own orders
// only, so it never touches or competes with other users' queue backlog.
async function creditPendingOrdersForUser(userId: string): Promise<boolean> {
  const paidOrders = await Order.find({ userId, status: 'paid' }).select('items');

  let credited = false;
  for (const paidOrder of paidOrders) {
    for (const item of paidOrder.items) {
      const itemId = item._id.toString();
      const alreadyCredited = await ProcessedCredit.exists({ orderItemId: itemId });
      if (!alreadyCredited) {
        await creditItem(paidOrder._id.toString(), userId, itemId, { skipDebugDelay: true });
        credited = true;
      }
    }
  }
  return credited;
}

router.post('/', async (req, res) => {
  try {
    const { userId, items, paymentOutcome, benefitId, autoApplyBenefit } = req.body as {
      userId?: string;
      items?: OrderItemInput[];
      paymentOutcome?: 'success' | 'failure';
      benefitId?: string;
      autoApplyBenefit?: boolean;
    };

    if (!userId || !Types.ObjectId.isValid(userId)) {
      res.status(400).json({ error: 'userId is required and must be a valid id' });
      return;
    }
    if (!items || items.length === 0) {
      res.status(400).json({ error: 'items must be a non-empty array' });
      return;
    }

    let user = await User.findById(userId);
    if (!user) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    const caughtUp = await creditPendingOrdersForUser(userId);
    if (caughtUp) {
      // Re-fetch — the catch-up above may have changed points/tier/benefits.
      user = await User.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
    }

    const itemsSubtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);

    // An explicit benefitId always wins (manual override). Otherwise, if
    // autoApplyBenefit is set, pick the oldest available one — evaluated
    // here, after the catch-up above, so a benefit that just unlocked from
    // an earlier pending order is picked up even though the caller never
    // saw it rendered anywhere.
    //
    // This first lookup only decides *which* benefit to attempt — it's a
    // read of an in-memory snapshot of `user`, so on its own it's not proof
    // the benefit is still available by the time we actually try to spend
    // it (see the atomic claim below).
    let benefitCandidate: (typeof user.benefits)[number] | undefined;
    if (benefitId) {
      benefitCandidate = Types.ObjectId.isValid(benefitId) ? (user.benefits.id(benefitId) ?? undefined) : undefined;
      if (!benefitCandidate || benefitCandidate.status !== 'available') {
        res.status(400).json({ error: 'benefitId is invalid or not available' });
        return;
      }
    } else if (autoApplyBenefit) {
      benefitCandidate = user.benefits.find((b) => b.status === 'available');
    }

    // Pre-generate the order id so it can be written into the benefit's
    // usedOnOrderId as part of the same atomic claim below, before the Order
    // document itself exists.
    const orderId = new Types.ObjectId();

    // Atomically claim the benefit — a single findOneAndUpdate filtered on
    // status: 'available' is a compare-and-swap at the database level,
    // unlike "read status, then later save()" (the previous approach),
    // which has a window between the read and the write. Without this, two
    // concurrent requests for the same user (e.g. the same account open on
    // two devices, both checking out around the same moment) can each read
    // the benefit as available and each go on to mark it used — applying a
    // one-time benefit twice. Whichever request's update reaches Mongo
    // first flips the status; the other's filter no longer matches and it
    // gets back null.
    //
    // $elemMatch, not two top-level 'benefits._id'/'benefits.status'
    // conditions: without it, those two conditions can each be satisfied by
    // a *different* array element (Mongo's documented behavior for
    // multi-field conditions on an array of subdocuments) — e.g. the
    // targeted benefit could already be 'used' while some other unrelated
    // benefit is still 'available', and the query would spuriously match
    // with the positional $ update then ambiguous about which element to
    // touch. $elemMatch forces both conditions onto the same element, which
    // is also what makes the positional $ in the update unambiguous.
    let benefit: (typeof user.benefits)[number] | undefined;
    if (benefitCandidate) {
      const claimed = await User.findOneAndUpdate(
        { _id: user._id, benefits: { $elemMatch: { _id: benefitCandidate._id, status: 'available' } } },
        { $set: { 'benefits.$.status': 'used', 'benefits.$.usedOnOrderId': orderId } },
        { new: true }
      );
      if (claimed) {
        user = claimed;
        benefit = user.benefits.id(benefitCandidate._id) ?? undefined;
      } else if (benefitId) {
        // An explicitly requested benefit lost the race between the read
        // above and this write — surface that rather than silently pricing
        // the order as if the user hadn't asked for it.
        res.status(409).json({
          error: 'benefit was just used elsewhere (e.g. another device) — refresh and try again',
        });
        return;
      }
      // An auto-applied benefit losing the race isn't an error: fall
      // through and price the order with no benefit, same as if none had
      // been available in the first place.
    }

    let discountedSubtotal = itemsSubtotal;
    let deliveryFee = DELIVERY_FEE;
    let benefitApplied: IOrder['benefitApplied'];

    if (benefit) {
      benefitApplied = { type: benefit.type, value: benefit.value };

      if (benefit.type === 'discount' && typeof benefit.value === 'number') {
        discountedSubtotal = itemsSubtotal * (1 - benefit.value / 100);
      } else if (benefit.type === 'free_item' && benefit.catalogId && typeof benefit.value === 'number') {
        const unitPrice = CATALOG_PRICE_BY_ID[benefit.catalogId] ?? 0;
        discountedSubtotal = Math.max(0, itemsSubtotal - unitPrice * benefit.value);
      } else if (benefit.type === 'free_delivery') {
        deliveryFee = 0;
      }
    }

    const totalAmount = Math.round((discountedSubtotal + deliveryFee) * 100) / 100;

    const order = await Order.create({
      _id: orderId,
      userId: user._id,
      items,
      deliveryFee,
      totalAmount,
      benefitApplied,
      status: 'pending',
    });

    // Mock payment step: caller controls the outcome for demo purposes
    // (defaults to success) rather than a real gateway callback.
    const outcome = paymentOutcome ?? 'success';

    if (outcome === 'failure') {
      order.status = 'failed';
      await order.save();
      // The benefit was already atomically claimed above (before payment was
      // attempted, so the claim could inform pricing). Payment failing means
      // it was never actually spent — release it back to 'available' so a
      // retry can use it, preserving the original behavior that a failed
      // payment doesn't burn the benefit.
      if (benefit) {
        await User.updateOne(
          { _id: user._id, 'benefits._id': benefit._id },
          { $set: { 'benefits.$.status': 'available' }, $unset: { 'benefits.$.usedOnOrderId': '' } }
        );
      }
      res.status(402).json({ error: 'payment failed', order });
      return;
    }

    order.status = 'paid';
    order.paidAt = new Date();
    await order.save();

    // Benefit consumption already happened atomically above, before pricing
    // — nothing left to do here on the success path.

    try {
      await publishOrderPaymentSucceeded(order);
    } catch (err) {
      // The order is already durably saved as 'paid' — that part genuinely
      // succeeded, so this isn't a 500. Publisher confirms (see
      // queue/producer.ts) mean we only land here when RabbitMQ itself never
      // accepted the event, so loyalty crediting for this order won't happen
      // on its own; say so explicitly instead of silently claiming success.
      console.error(`[orders] payment succeeded but event publish failed for order ${order._id}`, err);
      res.status(201).json({
        order,
        message:
          'payment succeeded, but loyalty crediting could not be queued (message broker unreachable) — points for this order were not credited',
      });
      return;
    }

    res.status(201).json({
      order,
      message: 'payment succeeded; loyalty points will be credited asynchronously',
    });
  } catch (err) {
    if ((err as { name?: string }).name === 'ValidationError') {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
