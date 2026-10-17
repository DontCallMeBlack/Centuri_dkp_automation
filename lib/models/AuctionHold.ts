import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAuctionHold extends Document {
  rowIndex: number;
  heldPoints: number;
  owner?: string;
  account?: string;
}

const AuctionHoldSchema: Schema<IAuctionHold> = new Schema({
  rowIndex: { type: Number, required: true, unique: true, min: 3, max: 1000, validate: Number.isInteger },
  heldPoints: { type: Number, required: true, min: 0, max: Number.MAX_SAFE_INTEGER, default: 0, validate: Number.isSafeInteger },
  owner: { type: String },
  account: { type: String },
}, { timestamps: true });

const AuctionHold: Model<IAuctionHold> = mongoose.models.AuctionHold
  || mongoose.model<IAuctionHold>('AuctionHold', AuctionHoldSchema);

export default AuctionHold;
