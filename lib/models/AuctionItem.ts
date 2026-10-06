import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAuctionItem extends Document {
  name: string;
  image: Buffer;
  imageType: 'image/png' | 'image/jpeg' | 'image/webp';
  createdBy: string;
  createdAt: Date;
}

const AuctionItemSchema: Schema<IAuctionItem> = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  image: { type: Buffer, required: true },
  imageType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

AuctionItemSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const AuctionItem: Model<IAuctionItem> = mongoose.models.AuctionItem
  || mongoose.model<IAuctionItem>('AuctionItem', AuctionItemSchema);

export default AuctionItem;
