import mongoose, { Document, Model, Schema } from 'mongoose';

export type ClanAuditEventType = 'promotion' | 'demotion' | 'member-removal' | 'toon-links' | 'toon-reference-refresh' | 'account-approval' | 'account-denial' | 'toon-created' | 'toon-restored' | 'toon-removed' | 'toon-dkp-wiped' | 'toon-transferred';

interface AuditToon { rowIndex?: number; owner: string; account: string }
interface AuditUserLinks { sheetRecords?: AuditToon[]; sheetRecordName?: string; linkedToons?: AuditToon[] }

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
  affectedToon?: AuditToon;
  forfeitedDkp?: string[];
  dkpBefore?: string[];
  withdrawnBids?: number;
  promotedBids?: number;
  undoneAt?: Date;
  undoneByUserId?: mongoose.Types.ObjectId;
  undoneByNickname?: string;
  undoRequestId?: string;
  dkpOperationKey?: string;
  activityWeeksBefore?: number[];
  hadPriorDkpReset?: boolean;
  priorDkpResetAt?: Date;
  priorDkpResetByUserId?: mongoose.Types.ObjectId;
  priorDkpResetByNickname?: string;
  sourceLinksBefore?: AuditUserLinks;
  sourceLinksAfter?: AuditUserLinks;
  destinationLinksBefore?: AuditUserLinks;
  destinationLinksAfter?: AuditUserLinks;
  createdAt: Date;
}

const ClanAuditEventSchema: Schema<IClanAuditEvent> = new Schema({
  eventType: {
    type: String,
    enum: ['promotion', 'demotion', 'member-removal', 'toon-links', 'toon-reference-refresh', 'account-approval', 'account-denial', 'toon-created', 'toon-restored', 'toon-removed', 'toon-dkp-wiped', 'toon-transferred'],
    required: true,
  },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  actorNickname: { type: String, required: true },
  actorRole: { type: String, required: true },
  targetUserId: { type: Schema.Types.ObjectId, required: function(this: IClanAuditEvent) { return !['toon-created', 'toon-restored', 'toon-removed', 'toon-dkp-wiped'].includes(this.eventType); } },
  transferToUserId: { type: Schema.Types.ObjectId },
  transferToNickname: { type: String },
  transferStatus: { type: String, enum: ['pending', 'completed'] },
  operationKey: { type: String },
  targetNickname: { type: String, required: true },
  previousRole: { type: String, required: true },
  newRole: { type: String },
  addedToons: { type: [new Schema({ rowIndex: Number, owner: String, account: String }, { _id: false })], default: undefined },
  removedToons: { type: [new Schema({ rowIndex: Number, owner: String, account: String }, { _id: false })], default: undefined },
  affectedToon: { type: new Schema({ rowIndex: Number, owner: String, account: String }, { _id: false }) },
  forfeitedDkp: { type: [String], default: undefined },
  dkpBefore: { type: [String], default: undefined },
  withdrawnBids: { type: Number, min: 0 },
  promotedBids: { type: Number, min: 0 },
  undoneAt: { type: Date },
  undoneByUserId: { type: Schema.Types.ObjectId },
  undoneByNickname: { type: String },
  undoRequestId: { type: String },
  dkpOperationKey: { type: String },
  activityWeeksBefore: { type: [Number], default: undefined },
  hadPriorDkpReset: { type: Boolean },
  priorDkpResetAt: { type: Date },
  priorDkpResetByUserId: { type: Schema.Types.ObjectId },
  priorDkpResetByNickname: { type: String },
  sourceLinksBefore: { type: Schema.Types.Mixed },
  sourceLinksAfter: { type: Schema.Types.Mixed },
  destinationLinksBefore: { type: Schema.Types.Mixed },
  destinationLinksAfter: { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

ClanAuditEventSchema.index({ createdAt: -1 });
ClanAuditEventSchema.index({ operationKey: 1 }, { unique: true, sparse: true });

const ClanAuditEvent: Model<IClanAuditEvent> = mongoose.models.ClanAuditEvent
  || mongoose.model<IClanAuditEvent>('ClanAuditEvent', ClanAuditEventSchema);

export default ClanAuditEvent;
