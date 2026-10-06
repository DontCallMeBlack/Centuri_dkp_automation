import mongoose, { Document, Model, Schema, Types } from 'mongoose';

export interface IAuctionBid {
  userId: Types.ObjectId;
  nickname: string;
  rowIndex: number;
  owner: string;
  account: string;
  amount: number;
  placedAt: Date;
}

export interface IAuction extends Document {
  itemId: Types.ObjectId;
  itemName: string;
  requiredRole: string;
  createdBy: string;
  endsAt: Date;
  status: 'active' | 'settling' | 'completed' | 'settlement-failed';
  highBid?: IAuctionBid;
  winner?: IAuctionBid;
  bidVersion: number;
  deliveryStatus: 'pending' | 'done' | 'not-required';
  deliveredBy?: string;
  deliveredAt?: Date;
  settlementError?: string;
  createdAt: Date;
}

const BidSchema = new Schema<IAuctionBid>({
  userId: { type: Schema.Types.ObjectId, required: true },
  nickname: { type: String, required: true },
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  amount: { type: Number, required: true },
  placedAt: { type: Date, required: true },
}, { _id: false });

const AuctionSchema: Schema<IAuction> = new Schema({
  itemId: { type: Schema.Types.ObjectId, ref: 'AuctionItem', required: true },
  itemName: { type: String, required: true },
  requiredRole: { type: String, required: true },
  createdBy: { type: String, required: true },
  endsAt: { type: Date, required: true },
  status: {
    type: String,
    enum: ['active', 'settling', 'completed', 'settlement-failed'],
    default: 'active',
    required: true,
  },
  highBid: { type: BidSchema },
  winner: { type: BidSchema },
  bidVersion: { type: Number, default: 0 },
  deliveryStatus: {
    type: String,
    enum: ['pending', 'done', 'not-required'],
    default: 'not-required',
    required: true,
  },
  deliveredBy: { type: String },
  deliveredAt: { type: Date },
  settlementError: { type: String },
}, { timestamps: { createdAt: true, updatedAt: true } });

AuctionSchema.index({ status: 1, endsAt: 1 });
AuctionSchema.index({ deliveryStatus: 1, status: 1 });

const Auction: Model<IAuction> = mongoose.models.Auction
  || mongoose.model<IAuction>('Auction', AuctionSchema);

export default Auction;
