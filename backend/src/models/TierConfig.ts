import { Schema, model, Document } from 'mongoose';
import { BENEFIT_TYPES, BenefitType } from '../constants';

export interface ITierBenefit {
  type: BenefitType;
  // discount: percentage off the items subtotal. free_item: quantity of
  // `catalogId` given free. free_delivery: unused.
  value: number | string;
  // Required when type === 'free_item' — which catalog item the benefit
  // applies to (a quantity alone isn't enough to price it).
  catalogId?: string;
  description: string;
}

export interface ITierConfig extends Document {
  name: string;
  minPoints: number;
  benefit: ITierBenefit;
}

const tierBenefitSchema = new Schema<ITierBenefit>(
  {
    type: { type: String, enum: BENEFIT_TYPES, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    catalogId: { type: String },
    description: { type: String, required: true },
  },
  { _id: false }
);

const tierConfigSchema = new Schema<ITierConfig>(
  {
    name: { type: String, required: true, unique: true },
    minPoints: { type: Number, required: true, unique: true },
    benefit: { type: tierBenefitSchema, required: true },
  },
  { collection: 'tier_configs', timestamps: true }
);

export const TierConfig = model<ITierConfig>('TierConfig', tierConfigSchema);
