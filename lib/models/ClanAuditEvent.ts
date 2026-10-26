import mongoose, { Document, Model, Schema } from 'mongoose';

export type ClanAuditEventType = 'promotion' | 'demotion' | 'member-removal' | 'toon-links' | 'toon-reference-refresh' | 'account-approval' | 'account-denial' | 'toon-created' | 'toon-removed' | 'toon-dkp-wiped' | 'toon-transferred';

interface AuditToon { rowIndex?: number; owner: string; account: string }

export interface IClanAuditEvent extends Document {
  eventType: ClanAuditEventType;
  actorUserId: mongoose.Types.ObjectId;
  actorNickname: string;
  actorRole: string;
  targetUserId?: mongoose.Types.ObjectId;
  transferToUserId?: mongoose.Types.ObjectId;
  transferToNickname?: string;
  transferStatus?: 'pending' | 'completed';
  operationKey?: string;
  targetNickname: string;
  previousRole: string;
  newRole?: string;
  addedToons?: AuditToon[];
  removedToons?: AuditToon[];
  forfeitedDkp?: string[];
  dkpBefore?: string[];
  withdrawnBids?: number;
  promotedBids?: number;
  createdAt: Date;
}

const ClanAuditEventSchema: Schema<IClanAuditEvent> = new Schema({
  eventType: {
    type: String,
    enum: ['promotion', 'demotion', 'member-removal', 'toon-links', 'toon-reference-refresh', 'account-approval', 'account-denial', 'toon-created', 'toon-removed', 'toon-dkp-wiped', 'toon-transferred'],
    required: true,
  },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  actorNickname: { type: String, required: true },
  actorRole: { type: String, required: true },
  targetUserId: { type: Schema.Types.ObjectId, required: function(this: IClanAuditEvent) { return !['toon-created', 'toon-removed', 'toon-dkp-wiped'].includes(this.eventType); } },
  transferToUserId: { type: Schema.Types.ObjectId },
  transferToNickname: { type: String },
  transferStatus: { type: String, enum: ['pending', 'completed'] },
  operationKey: { type: String },
  targetNickname: { type: String, required: true },
  previousRole: { type: String, required: true },
  newRole: { type: String },
  addedToons: { type: [new Schema({ rowIndex: Number, owner: String, account: String }, { _id: false })], default: undefined },
  removedToons: { type: [new Schema({ rowIndex: Number, owner: String, account: String }, { _id: false })], default: undefined },
  forfeitedDkp: { type: [String], default: undefined },
  dkpBefore: { type: [String], default: undefined },
  withdrawnBids: { type: Number, min: 0 },
  promotedBids: { type: Number, min: 0 },
}, { timestamps: { createdAt: true, updatedAt: false } });

ClanAuditEventSchema.index({ createdAt: -1 });
ClanAuditEventSchema.index({ operationKey: 1 }, { unique: true, sparse: true });

const ClanAuditEvent: Model<IClanAuditEvent> = mongoose.models.ClanAuditEvent
  || mongoose.model<IClanAuditEvent>('ClanAuditEvent', ClanAuditEventSchema);

export default ClanAuditEvent;
