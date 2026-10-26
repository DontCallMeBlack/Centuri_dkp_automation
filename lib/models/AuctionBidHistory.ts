import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IAuctionBidHistory extends mongoose.Document {
  auctionId: Types.ObjectId;
  userId: Types.ObjectId;
  nickname: string;
  rowIndex: number;
  owner: string;
  account: string;
  identityKey: string;
  amount: number;
  placedAt: Date;
  withdrawnAt?: Date;
}

const AuctionBidHistorySchema = new Schema<IAuctionBidHistory>({
  auctionId: { type: Schema.Types.ObjectId, ref: 'Auction', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  nickname: { type: String, required: true },
  rowIndex: { type: Number, required: true, min: 3, max: 1000, validate: Number.isInteger },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  identityKey: { type: String, required: true },
  amount: { type: Number, required: true, min: 1, max: Number.MAX_SAFE_INTEGER, validate: Number.isSafeInteger },
  placedAt: { type: Date, required: true },
  withdrawnAt: { type: Date },
}, { timestamps: { createdAt: true, updatedAt: false } });

AuctionBidHistorySchema.index({ auctionId: 1, identityKey: 1, withdrawnAt: 1, amount: -1, placedAt: 1 });
AuctionBidHistorySchema.index({ identityKey: 1, withdrawnAt: 1 });

const AuctionBidHistory: Model<IAuctionBidHistory> = mongoose.models.AuctionBidHistory
  || mongoose.model<IAuctionBidHistory>('AuctionBidHistory', AuctionBidHistorySchema);

export default AuctionBidHistory;
