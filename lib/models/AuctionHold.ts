import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAuctionHold extends Document {
  rowIndex: number;
  heldPoints: number;
}

const AuctionHoldSchema: Schema<IAuctionHold> = new Schema({
  rowIndex: { type: Number, required: true, unique: true },
  heldPoints: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true });

const AuctionHold: Model<IAuctionHold> = mongoose.models.AuctionHold
  || mongoose.model<IAuctionHold>('AuctionHold', AuctionHoldSchema);

export default AuctionHold;
