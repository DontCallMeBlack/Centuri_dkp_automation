import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IToonDkpReset extends mongoose.Document {
  identityKey: string;
  owner: string;
  account: string;
  resetAt: Date;
  resetByUserId: Types.ObjectId;
  resetByNickname: string;
}

const ToonDkpResetSchema = new Schema<IToonDkpReset>({
  identityKey: { type: String, required: true, unique: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  resetAt: { type: Date, required: true },
  resetByUserId: { type: Schema.Types.ObjectId, required: true },
  resetByNickname: { type: String, required: true },
}, { timestamps: true });

const ToonDkpReset: Model<IToonDkpReset> = mongoose.models.ToonDkpReset
  || mongoose.model<IToonDkpReset>('ToonDkpReset', ToonDkpResetSchema);

export default ToonDkpReset;
