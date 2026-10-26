import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IToonRoleChangeAudit extends mongoose.Document {
  action: 'requested' | 'approved' | 'denied' | 'cancelled' | 'expired';
  identityKey: string;
  owner: string;
  account: string;
  previousRole: string;
  scheduledRole: string;
  effectiveAt?: Date;
  actorUserId?: Types.ObjectId;
  actorNickname: string;
  actorRole: 'chief' | 'general' | 'guardian' | 'clansman' | 'system';
  createdAt: Date;
}

const ToonRoleChangeAuditSchema = new Schema<IToonRoleChangeAudit>({
  action: { type: String, enum: ['requested', 'approved', 'denied', 'cancelled', 'expired'], required: true },
  identityKey: { type: String, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  previousRole: { type: String, required: true },
  scheduledRole: { type: String, required: true },
  effectiveAt: { type: Date },
  actorUserId: { type: Schema.Types.ObjectId },
  actorNickname: { type: String, required: true },
  actorRole: { type: String, enum: ['chief', 'general', 'guardian', 'clansman', 'system'], required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

ToonRoleChangeAuditSchema.index({ createdAt: -1 });

const ToonRoleChangeAudit: Model<IToonRoleChangeAudit> = mongoose.models.ToonRoleChangeAudit
  || mongoose.model<IToonRoleChangeAudit>('ToonRoleChangeAudit', ToonRoleChangeAuditSchema);

export default ToonRoleChangeAudit;
