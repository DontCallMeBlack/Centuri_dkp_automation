import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IToonRoleChange extends mongoose.Document {
  identityKey: string;
  owner: string;
  account: string;
  currentRole: string;
  scheduledRole?: string;
  effectiveAt?: Date;
  updatedByUserId: Types.ObjectId;
  updatedByNickname: string;
  createdAt: Date;
  updatedAt: Date;
}

const ToonRoleChangeSchema = new Schema<IToonRoleChange>({
  identityKey: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  currentRole: { type: String, required: true },
  scheduledRole: { type: String },
  effectiveAt: { type: Date },
  updatedByUserId: { type: Schema.Types.ObjectId, required: true },
  updatedByNickname: { type: String, required: true },
}, { timestamps: true });

const ToonRoleChange: Model<IToonRoleChange> = mongoose.models.ToonRoleChange
  || mongoose.model<IToonRoleChange>('ToonRoleChange', ToonRoleChangeSchema);

export default ToonRoleChange;
