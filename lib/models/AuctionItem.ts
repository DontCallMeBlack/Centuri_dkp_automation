import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAuctionItem extends Document {
  name: string;
  images: Array<{
    data: Buffer;
    contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  }>;
  image?: Buffer;
  imageType?: 'image/png' | 'image/jpeg' | 'image/webp';
  imageCount: number;
  createdBy: string;
  createdAt: Date;
}

const AuctionItemImageSchema = new Schema({
  data: { type: Buffer, required: true },
  contentType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
}, { _id: false });

const AuctionItemSchema: Schema<IAuctionItem> = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  images: { type: [AuctionItemImageSchema], default: [] },
  image: { type: Buffer },
  imageType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'] },
  imageCount: { type: Number, required: true, default: 1, min: 1 },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

AuctionItemSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

const AuctionItem: Model<IAuctionItem> = mongoose.models.AuctionItem
  || mongoose.model<IAuctionItem>('AuctionItem', AuctionItemSchema);

export default AuctionItem;
