import amqplib, { ConfirmChannel, ChannelModel } from 'amqplib';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://admin:admin123@localhost:5672';

export const EXCHANGE_NAME = 'loyalty';
export const ORDER_PAYMENT_SUCCEEDED_ROUTING_KEY = 'order.payment.succeeded';
export const POINTS_CREDIT_QUEUE = 'loyalty.points_credit';

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;

// Single shared channel for the whole app (producer + consumer + health
// check) — plenty for this demo's throughput, and it's what guarantees the
// topic exchange/queue/binding exist before anything tries to use them.
//
// A confirm channel (not a plain channel) — publisher confirms mean
// `channel.publish` only reports success once RabbitMQ has actually
// acknowledged receipt of the message, not just that it left this process.
// See producer.ts for why that distinction matters.
export async function getChannel(): Promise<ConfirmChannel> {
  if (channel) return channel;

  connection = await amqplib.connect(RABBITMQ_URL);

  connection.on('error', (err) => {
    console.error('[rabbitmq] connection error', err);
  });

  // Exit rather than limp along on a dead connection: amqplib doesn't
  // reconnect on its own, and this module caches the connection/channel in
  // module-level variables — once the broker is gone, every cached handle
  // is dead too, so every subsequent publish/consume would fail or hang
  // with nothing logged to explain why. For a demo where the operator
  // controls the environment, an explicit crash-and-restart is the honest
  // failure mode; a process that quietly stops doing anything useful is not.
  //
  // A production service would not do this — it would use something like
  // amqp-connection-manager, or a hand-rolled reconnect-with-backoff that
  // re-establishes the connection, re-asserts the exchange/queue/binding,
  // and re-registers consumers once the broker comes back, so a transient
  // network blip doesn't take the whole process down.
  connection.on('close', () => {
    console.error('[rabbitmq] connection closed — exiting so the process can be restarted');
    process.exit(1);
  });

  channel = await connection.createConfirmChannel();

  channel.on('error', (err) => {
    console.error('[rabbitmq] channel error', err);
  });

  await channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });
  await channel.assertQueue(POINTS_CREDIT_QUEUE, { durable: true });
  await channel.bindQueue(POINTS_CREDIT_QUEUE, EXCHANGE_NAME, ORDER_PAYMENT_SUCCEEDED_ROUTING_KEY);

  return channel;
}
