import mongoose, { Schema, type Model, type Types } from 'mongoose';

export type ToonRoleChangeRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'applied';

export interface IToonRoleChangeRequest extends mongoose.Document {
  identityKey: string;
  owner: string;
  account: string;
  currentRole: string;
  requestedRole: string;
  effectiveAt: Date;
  status: ToonRoleChangeRequestStatus;
  requestedByUserId: Types.ObjectId;
  requestedByNickname: string;
  decidedByUserId?: Types.ObjectId;
  decidedByNickname?: string;
  decidedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ToonRoleChangeRequestSchema = new Schema<IToonRoleChangeRequest>({
  identityKey: { type: String, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  currentRole: { type: String, required: true },
  requestedRole: { type: String, required: true },
  effectiveAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'approved', 'denied', 'cancelled', 'expired', 'applied'], required: true },
  requestedByUserId: { type: Schema.Types.ObjectId, required: true },
  requestedByNickname: { type: String, required: true },
  decidedByUserId: { type: Schema.Types.ObjectId },
  decidedByNickname: { type: String },
  decidedAt: { type: Date },
}, { timestamps: true });

ToonRoleChangeRequestSchema.index({ identityKey: 1, createdAt: -1 });
ToonRoleChangeRequestSchema.index({ status: 1, effectiveAt: 1 });

const ToonRoleChangeRequest: Model<IToonRoleChangeRequest> = mongoose.models.ToonRoleChangeRequest
  || mongoose.model<IToonRoleChangeRequest>('ToonRoleChangeRequest', ToonRoleChangeRequestSchema);

export default ToonRoleChangeRequest;
