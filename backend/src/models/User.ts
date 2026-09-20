import { Schema, model, Document, Types } from 'mongoose';
import { BENEFIT_TYPES, BenefitType } from '../constants';

export interface IBenefit {
  // Auto-generated — the id the checkout flow applies a specific benefit by
  // (benefits are opt-in at checkout, not auto-applied, so they need to be
  // individually addressable).
  _id: Types.ObjectId;
  type: BenefitType;
  value: number | string;
  catalogId?: string; // set when type === 'free_item' — see ITierBenefit
  description?: string;
  earnedFromTier: string;
  status: 'available' | 'used';
  grantedAt: Date;
  usedOnOrderId?: Types.ObjectId;
}

export interface IUser extends Document {
  email: string;
  name: string;
  loyalty: {
    points: number;
    tier?: string;
    tierUpdatedAt?: Date;
  };
  benefits: Types.DocumentArray<IBenefit>;
}

const benefitSchema = new Schema<IBenefit>({
  type: { type: String, enum: BENEFIT_TYPES, required: true },
  value: { type: Schema.Types.Mixed, required: true },
  catalogId: { type: String },
  description: { type: String },
  earnedFromTier: { type: String, required: true },
  status: { type: String, enum: ['available', 'used'], default: 'available' },
  grantedAt: { type: Date, default: Date.now },
  usedOnOrderId: { type: Schema.Types.ObjectId, ref: 'Order' },
});

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    loyalty: {
      points: { type: Number, default: 0 },
      tier: { type: String },
      tierUpdatedAt: { type: Date },
    },
    benefits: { type: [benefitSchema], default: [] },
  },
  { timestamps: true }
);

export const User = model<IUser>('User', userSchema);
