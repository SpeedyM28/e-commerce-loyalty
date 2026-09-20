import 'dotenv/config';
import mongoose from 'mongoose';
import { TierConfig } from '../models/TierConfig';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/loyalty';

// Demo tier ladder — merchant-defined, edit freely. Thresholds set tight
// ($100 apart) so tiers are reachable quickly for demo/recording purposes.
const TIERS = [
  { name: 'bronze', minPoints: 100, benefit: { type: 'discount', value: 5, description: '5% off your next order' } },
  { name: 'silver', minPoints: 200, benefit: { type: 'discount', value: 10, description: '10% off your next order' } },
  { name: 'gold', minPoints: 300, benefit: { type: 'free_delivery', value: 'free', description: 'Free delivery on your next order' } },
  {
    name: 'platinum',
    minPoints: 400,
    benefit: { type: 'free_item', value: 5, catalogId: 'sku-combo', description: '5 free Lunch Combos' },
  },
] as const;

async function seed() {
  await mongoose.connect(MONGO_URI);

  for (const tier of TIERS) {
    await TierConfig.findOneAndUpdate({ name: tier.name }, { $set: tier }, { upsert: true, new: true });
    console.log(`[seed] upserted tier "${tier.name}" (minPoints=${tier.minPoints})`);
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
