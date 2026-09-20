import { Schema, model, Document, Types } from 'mongoose';

// One doc per successfully credited order line-item. The unique index on
// orderItemId is the actual idempotency guard — a duplicate insert (retry,
// redelivery) throws E11000 and the consumer treats that as "already done"
// rather than crediting twice.
export interface IProcessedCredit extends Document {
  orderItemId: string; // Order.items[]._id, as a string
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  pointsCredited: number;
  processedAt: Date;
}

const processedCreditSchema = new Schema<IProcessedCredit>({
  orderItemId: { type: String, required: true, unique: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  pointsCredited: { type: Number, required: true },
  processedAt: { type: Date, default: Date.now },
});

export const ProcessedCredit = model<IProcessedCredit>('ProcessedCredit', processedCreditSchema);
