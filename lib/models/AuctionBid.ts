import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IAuctionBidRecord extends Document {
  auctionId: Types.ObjectId;
  userId: Types.ObjectId;
  nickname: string;
  rowIndex: number;
  owner: string;
  account: string;
  amount: number;
  placedAt: Date;
}

const AuctionBidRecordSchema = new Schema<IAuctionBidRecord>({
  auctionId: { type: Schema.Types.ObjectId, ref: 'Auction', required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  nickname: { type: String, required: true },
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  amount: { type: Number, required: true },
  placedAt: { type: Date, required: true },
}, { versionKey: false });

AuctionBidRecordSchema.index({ auctionId: 1, placedAt: -1 });

const AuctionBid: Model<IAuctionBidRecord> = mongoose.models.AuctionBid
  || mongoose.model<IAuctionBidRecord>('AuctionBid', AuctionBidRecordSchema);

export default AuctionBid;
