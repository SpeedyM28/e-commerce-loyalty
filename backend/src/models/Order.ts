import { Schema, model, Document, Types } from 'mongoose';

export interface IOrderItem {
  // Unique per purchase — this is the "purchased-item ID" referenced in queue
  // messages and the ProcessedCredit dedup ledger.
  _id: Types.ObjectId;
  // Product/catalog reference (e.g. SKU) — repeats across orders and users,
  // not usable as a dedup or queue-reference key.
  catalogId: string;
  name: string;
  price: number;
  qty: number;
}

export interface IBenefitApplied {
  type: string;
  value: number | string;
}

export interface IOrder extends Document {
  userId: Types.ObjectId;
  items: Types.DocumentArray<IOrderItem>;
  deliveryFee: number;
  totalAmount: number;
  benefitApplied?: IBenefitApplied;
  status: 'pending' | 'paid' | 'failed';
  paidAt?: Date;
}

// No { _id: false } here: each line item keeps its own auto-generated _id (see
// IOrderItem above).
const orderItemSchema = new Schema<IOrderItem>({
  catalogId: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  qty: { type: Number, required: true },
});

const benefitAppliedSchema = new Schema<IBenefitApplied>(
  {
    type: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const orderSchema = new Schema<IOrder>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items: { type: [orderItemSchema], required: true },
    deliveryFee: { type: Number, required: true },
    totalAmount: { type: Number, required: true },
    benefitApplied: { type: benefitAppliedSchema },
    status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export const Order = model<IOrder>('Order', orderSchema);
