import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IAuctionItem extends Document {
  name: string;
  requiredRoles: string[];
  requiredRole?: string;
  bossType: 'Prot' | 'Bt' | 'Gele' | 'Dino' | 'Crom' | 'Legacy' | 'Unassigned';
  images: Array<{
    data: Buffer;
    contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  }>;
  image?: Buffer;
  imageType?: 'image/png' | 'image/jpeg' | 'image/webp';
  imageCount: number;
  isListed: boolean;
  createdBy: string;
  createdAt: Date;
}

const AuctionItemImageSchema = new Schema({
  data: { type: Buffer, required: true },
  contentType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'], required: true },
}, { _id: false });

const AuctionItemSchema: Schema<IAuctionItem> = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  requiredRoles: { type: [String], default: undefined },
  requiredRole: { type: String, default: '' },
  bossType: {
    type: String,
    enum: ['Prot', 'Bt', 'Gele', 'Dino', 'Crom', 'Legacy', 'Unassigned'],
    default: 'Unassigned',
    required: true,
  },
  images: { type: [AuctionItemImageSchema], default: [] },
  image: { type: Buffer },
  imageType: { type: String, enum: ['image/png', 'image/jpeg', 'image/webp'] },
  imageCount: { type: Number, required: true, default: 1, min: 1, max: 8, validate: Number.isInteger },
  isListed: { type: Boolean, required: true, default: true },
  createdBy: { type: String, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

// Archived records retain their names/images for auction history. Only the
// listed catalog reserves a name. Existing databases also need the migration
// in scripts/migrate-catalog-name-index.cjs to release the old global index.
AuctionItemSchema.index({ name: 1 }, {
  name: 'listed_item_name_unique',
  unique: true,
  collation: { locale: 'en', strength: 2 },
  partialFilterExpression: { isListed: true },
});

const AuctionItem: Model<IAuctionItem> = mongoose.models.AuctionItem
  || mongoose.model<IAuctionItem>('AuctionItem', AuctionItemSchema);

export default AuctionItem;
