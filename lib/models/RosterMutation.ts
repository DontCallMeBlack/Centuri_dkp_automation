import mongoose, { Schema, type Model } from 'mongoose';

export interface RosterMutationRecord {
  _id: string;
  spreadsheetId: string;
  fingerprint: string;
  action: 'create' | 'remove' | 'restore';
  status: 'pending' | 'applied';
  rowIndex: number;
  identityKey: string;
  owner: string;
  account: string;
  subClass: string;
  before: string[];
  after: Array<string | number>;
  compaction?: {
    endRow: number;
    beforeRows: string[][];
    afterRows: Array<Array<string | number>>;
    deletedRows: number[];
    moves: Array<{ owner: string; account: string; fromRow: number; toRow: number }>;
  };
  actorUserId: mongoose.Types.ObjectId;
  actorNickname: string;
  actorRole: string;
  undoEventId?: string;
  undoRequestId?: string;
  archiveMutationId?: string;
  restoredAt?: Date;
  restoredByUserId?: mongoose.Types.ObjectId;
  restoredByNickname?: string;
  restoreRequestId?: string;
  removalEventId?: mongoose.Types.ObjectId;
  archiveLinks?: Array<{
    userId: string;
    beforeSheetRecords?: Array<{ owner: string; account: string; rowIndex?: number }>;
    beforeSheetRecordName?: string;
    afterLinks: Array<{ owner: string; account: string; rowIndex?: number }>;
  }>;
  weeklyActivityBefore?: number[];
  restoredWeeklyActivity?: number[];
  toonRoleChangeBefore?: Record<string, unknown>;
  linkChanges: Array<{ userId: string; links: Array<{ owner: string; account: string; rowIndex?: number }> }>;
  createdAt: Date;
}
const schema = new Schema<RosterMutationRecord>({
  _id: { type: String, required: true }, spreadsheetId: { type: String, required: true },
  fingerprint: { type: String, required: true }, action: { type: String, enum: ['create', 'remove', 'restore'], required: true },
  status: { type: String, enum: ['pending', 'applied'], required: true },
  rowIndex: { type: Number, required: true }, identityKey: { type: String, required: true },
  owner: { type: String, required: true }, account: { type: String, default: '' }, subClass: { type: String, default: '' },
  before: { type: [String], required: true }, after: { type: Schema.Types.Mixed, required: true },
  compaction: { type: Schema.Types.Mixed },
  actorUserId: { type: Schema.Types.ObjectId, required: true }, actorNickname: { type: String, required: true }, actorRole: { type: String, required: true },
  undoEventId: { type: String }, undoRequestId: { type: String },
  archiveMutationId: { type: String }, restoredAt: { type: Date }, restoredByUserId: { type: Schema.Types.ObjectId },
  restoredByNickname: { type: String }, restoreRequestId: { type: String }, removalEventId: { type: Schema.Types.ObjectId },
  archiveLinks: { type: Schema.Types.Mixed }, weeklyActivityBefore: { type: [Number] }, restoredWeeklyActivity: { type: [Number] },
  toonRoleChangeBefore: { type: Schema.Types.Mixed },
  linkChanges: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ spreadsheetId: 1, status: 1 });
schema.index({ spreadsheetId: 1, identityKey: 1, action: 1 });
schema.index({ removalEventId: 1 }, { sparse: true });
const RosterMutation: Model<RosterMutationRecord> = mongoose.models.RosterMutation || mongoose.model('RosterMutation', schema);
export default RosterMutation;
