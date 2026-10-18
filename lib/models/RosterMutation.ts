import mongoose, { Schema, type Model } from 'mongoose';

export interface RosterMutationRecord {
  _id: string;
  spreadsheetId: string;
  fingerprint: string;
  action: 'create' | 'remove';
  status: 'pending' | 'applied';
  rowIndex: number;
  identityKey: string;
  owner: string;
  account: string;
  subClass: string;
  before: string[];
  after: Array<string | number>;
  actorUserId: mongoose.Types.ObjectId;
  actorNickname: string;
  actorRole: string;
  linkChanges: Array<{ userId: string; links: Array<{ owner: string; account: string; rowIndex?: number }> }>;
  createdAt: Date;
}
const schema = new Schema<RosterMutationRecord>({
  _id: { type: String, required: true }, spreadsheetId: { type: String, required: true },
  fingerprint: { type: String, required: true }, action: { type: String, enum: ['create', 'remove'], required: true },
  status: { type: String, enum: ['pending', 'applied'], required: true },
  rowIndex: { type: Number, required: true }, identityKey: { type: String, required: true },
  owner: { type: String, required: true }, account: { type: String, default: '' }, subClass: { type: String, default: '' },
  before: { type: [String], required: true }, after: { type: Schema.Types.Mixed, required: true },
  actorUserId: { type: Schema.Types.ObjectId, required: true }, actorNickname: { type: String, required: true }, actorRole: { type: String, required: true },
  linkChanges: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ spreadsheetId: 1, status: 1 });
schema.index({ spreadsheetId: 1, identityKey: 1, action: 1 });
const RosterMutation: Model<RosterMutationRecord> = mongoose.models.RosterMutation || mongoose.model('RosterMutation', schema);
export default RosterMutation;
