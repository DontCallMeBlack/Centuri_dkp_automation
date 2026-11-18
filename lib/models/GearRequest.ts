import mongoose, { Schema, type Model } from 'mongoose';

export interface IGearRequest extends mongoose.Document {
  setType: 'DG' | 'BDG';
  rowIndex: number;
  owner: string;
  account: string;
  status: 'requested' | 'pending-mail' | 'geared' | 'awarded' | 'cancelled';
  requesterUserId?: string;
  requestedBy: string;
  requestedAt: Date;
  winnerRevealedAt?: Date;
  recipientRowIndex?: number;
  recipientOwner?: string;
  recipientAccount?: string;
  mailedAt?: Date;
  mailedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GearRequestSchema = new Schema<IGearRequest>({
  setType: { type: String, enum: ['DG', 'BDG'], required: true },
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  status: { type: String, enum: ['requested', 'pending-mail', 'geared', 'awarded', 'cancelled'], required: true },
  requesterUserId: { type: String },
  requestedBy: { type: String, required: true },
  requestedAt: { type: Date, required: true },
  winnerRevealedAt: { type: Date },
  recipientRowIndex: { type: Number },
  recipientOwner: { type: String },
  recipientAccount: { type: String },
  mailedAt: { type: Date },
  mailedBy: { type: String },
}, { timestamps: true });

GearRequestSchema.index({ setType: 1, rowIndex: 1, createdAt: -1 });
GearRequestSchema.index({ setType: 1, status: 1, requestedAt: 1 });

const GearRequest: Model<IGearRequest> = mongoose.models.GearRequest || mongoose.model<IGearRequest>('GearRequest', GearRequestSchema);
export default GearRequest;
