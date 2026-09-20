import { getChannel, EXCHANGE_NAME, ORDER_PAYMENT_SUCCEEDED_ROUTING_KEY } from './connection';
import { IOrder } from '../models/Order';

export interface OrderPaymentSucceededEvent {
  orderId: string;
  userId: string;
  itemIds: string[]; // Order.items[]._id, one per purchased line item
}

// Called after the mock payment step resolves success. Deliberately thin —
// just the ids — so the consumer is the single source of truth for pricing
// (it re-reads the Order document rather than trusting stale event payload).
//
// Publisher confirms: `channel` here is a confirm channel (see
// queue/connection.ts), so `publish`'s callback only fires once RabbitMQ has
// actually acknowledged the message — not merely that it was written to the
// socket. Without this, a broker that's unreachable or refusing writes (e.g.
// a full queue hitting a resource limit) would still let a plain
// `channel.publish` return silently: the order would already be saved as
// paid, the caller would report success, and the event — and therefore all
// future loyalty crediting for this order — would simply be lost with no
// signal anywhere. Wrapping the callback form in a promise turns that into a
// rejection the caller (routes/orders.ts) can actually see and act on.
export async function publishOrderPaymentSucceeded(order: IOrder): Promise<void> {
  const channel = await getChannel();

  const event: OrderPaymentSucceededEvent = {
    orderId: order._id.toString(),
    userId: order.userId.toString(),
    itemIds: order.items.map((item) => item._id.toString()),
  };

  await new Promise<void>((resolve, reject) => {
    channel.publish(
      EXCHANGE_NAME,
      ORDER_PAYMENT_SUCCEEDED_ROUTING_KEY,
      Buffer.from(JSON.stringify(event)),
      { persistent: true },
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}
