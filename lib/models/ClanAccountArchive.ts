import mongoose, { Schema, type Model, type Types } from 'mongoose';

export interface IClanAccountArchive extends mongoose.Document {
  userId: Types.ObjectId;
  auditEventId: Types.ObjectId;
  nickname: string;
  nicknameKey: string;
  passwordHash?: string;
  role: 'chief' | 'general' | 'guardian' | 'clansman';
  originalStatus: 'approved' | 'pending';
  linkedToons: Array<{ owner: string; account: string }>;
  createdAt: Date;
  archiveReason: 'member-removal' | 'account-denial';
  archivedAt: Date;
  archivedByUserId: Types.ObjectId;
  archivedByNickname: string;
  status: 'archived' | 'restored';
  restoredAt?: Date;
  restoredByUserId?: Types.ObjectId;
  restoredByNickname?: string;
  restoreRequestId?: string;
}

const ToonIdentitySchema = new Schema({ owner: { type: String, required: true }, account: { type: String, default: '' } }, { _id: false });
const ClanAccountArchiveSchema = new Schema<IClanAccountArchive>({
  userId: { type: Schema.Types.ObjectId, required: true },
  auditEventId: { type: Schema.Types.ObjectId, required: true, unique: true },
  nickname: { type: String, required: true },
  nicknameKey: { type: String, required: true },
  passwordHash: { type: String, required: function(this: IClanAccountArchive) { return this.status === 'archived'; } },
  role: { type: String, enum: ['chief', 'general', 'guardian', 'clansman'], required: true },
  originalStatus: { type: String, enum: ['approved', 'pending'], required: true },
  linkedToons: { type: [ToonIdentitySchema], default: [] },
  createdAt: { type: Date, required: true },
  archiveReason: { type: String, enum: ['member-removal', 'account-denial'], required: true },
  archivedAt: { type: Date, required: true },
  archivedByUserId: { type: Schema.Types.ObjectId, required: true },
  archivedByNickname: { type: String, required: true },
  status: { type: String, enum: ['archived', 'restored'], default: 'archived', required: true },
  restoredAt: { type: Date },
  restoredByUserId: { type: Schema.Types.ObjectId },
  restoredByNickname: { type: String },
  restoreRequestId: { type: String },
}, { timestamps: true });

ClanAccountArchiveSchema.index({ nicknameKey: 1 }, { unique: true, partialFilterExpression: { status: 'archived' } });
ClanAccountArchiveSchema.index({ status: 1, archivedAt: -1 });

const ClanAccountArchive: Model<IClanAccountArchive> = mongoose.models.ClanAccountArchive
  || mongoose.model<IClanAccountArchive>('ClanAccountArchive', ClanAccountArchiveSchema);

export default ClanAccountArchive;
