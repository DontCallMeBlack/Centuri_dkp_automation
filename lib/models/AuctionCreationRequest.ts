import mongoose, { Schema, type Model } from 'mongoose';

interface CreationRequest { _id: string; actorUserId: mongoose.Types.ObjectId; itemId: mongoose.Types.ObjectId; auctionId: mongoose.Types.ObjectId }
const schema = new Schema<CreationRequest>({
  _id: { type: String, required: true },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  itemId: { type: Schema.Types.ObjectId, required: true },
  auctionId: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
// Receipts intentionally survive removal of an auction. A late retry must
// acknowledge the original request rather than recreate a removed auction.
const AuctionCreationRequest: Model<CreationRequest> = mongoose.models.AuctionCreationRequest
  || mongoose.model<CreationRequest>('AuctionCreationRequest', schema);
export default AuctionCreationRequest;
