import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { getChannel } from './queue/connection';
import { startLoyaltyConsumer } from './queue/consumer';
import usersRouter from './routes/users';
import ordersRouter from './routes/orders';
import catalogRouter from './routes/catalog';

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/loyalty';

// Trivial schema used only to prove Mongo read/write works end to end.
const HealthCheckModel = mongoose.model(
  'HealthCheck',
  new mongoose.Schema({ checkedAt: Date }) 
  // unnecessary renaming, default behavior is same + "s" = HealthChecks { collection: 'health_checks' }
);

async function connectMongo() {
  await mongoose.connect(MONGO_URI);
  console.log('[mongo] connected');
}

async function checkMongo() {
  const doc = await HealthCheckModel.create({ checkedAt: new Date() });
  const found = await HealthCheckModel.findById(doc._id);
  await HealthCheckModel.deleteOne({ _id: doc._id });
  return Boolean(found);
}

async function checkRabbit() {
  const channel = await getChannel();
  const queue = 'health_check_queue';
  await channel.assertQueue(queue, { durable: false });

  const payload = { pingedAt: new Date().toISOString() };
  channel.sendToQueue(queue, Buffer.from(JSON.stringify(payload)));

  return new Promise<boolean>((resolve, reject) => {
    let consumerTag: string | undefined;
    const timeout = setTimeout(() => {
      if (consumerTag) channel.cancel(consumerTag).catch(() => {});
      reject(new Error('rabbitmq consume timed out'));
    }, 3000);

    channel
      .consume(
        queue,
        (msg) => {
          if (msg) {
            clearTimeout(timeout);
            channel.ack(msg);
            if (consumerTag) channel.cancel(consumerTag).catch(() => {});
            resolve(true);
          }
        },
        { noAck: false }
      )
      .then((reply) => {
        consumerTag = reply.consumerTag;
      });
  });
}

async function main() {
  await connectMongo();
  await getChannel();
  await startLoyaltyConsumer();

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use('/users', usersRouter);
  app.use('/orders', ordersRouter);
  app.use('/catalog', catalogRouter);

  app.get('/health', async (_req, res) => {
    try {
      const [mongoOk, rabbitOk] = await Promise.all([checkMongo(), checkRabbit()]);
      res.json({ mongo: mongoOk, rabbitmq: rabbitOk });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('failed to start server', err);
  process.exit(1);
});
