import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IBossAwardParticipant {
  rowIndex: number;
  owner: string;
  account: string;
}

export interface IBossAwardAuditEntry {
  kind: 'participant_added' | 'participant_removed' | 'kill_deleted';
  changeId?: string;
  participant?: IBossAwardParticipant;
  reason?: 'underperforming' | 'afk' | 'not helping with boss mechanics' | "didn't attend" | 'other';
  actor: string;
  occurredAt: Date;
}

export interface IBossAward extends Document {
  bossName: string;
  points: number;
  participants: IBossAwardParticipant[];
  auditTrail?: IBossAwardAuditEntry[];
  createdBy: string;
  updatedBy?: string;
  requestId?: string;
  requestFingerprint?: string;
  completedRequests?: Array<{ requestId: string; fingerprint: string }>;
  pendingChange?: {
    requestId: string;
    fingerprint: string;
    kind: 'edit' | 'delete';
    participants: IBossAwardParticipant[];
    removalReasons?: Array<{
      owner: string;
      account: string;
      reason: NonNullable<IBossAwardAuditEntry['reason']>;
    }>;
    updatedBy: string;
  };
  status: 'pending' | 'applied' | 'failed' | 'updating' | 'deleted';
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParticipantSchema = new Schema<IBossAwardParticipant>({
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
}, { _id: false });

const AuditEntrySchema = new Schema<IBossAwardAuditEntry>({
  kind: { type: String, enum: ['participant_added', 'participant_removed', 'kill_deleted'], required: true },
  changeId: { type: String },
  participant: { type: ParticipantSchema },
  reason: { type: String, enum: ['underperforming', 'afk', 'not helping with boss mechanics', "didn't attend", 'other'] },
  actor: { type: String, required: true },
  occurredAt: { type: Date, required: true },
}, { _id: false });

const BossAwardSchema: Schema<IBossAward> = new Schema({
  bossName: { type: String, required: true },
  points: { type: Number, required: true },
  participants: { type: [ParticipantSchema], default: [] },
  auditTrail: { type: [AuditEntrySchema], default: [] },
  createdBy: { type: String, required: true },
  updatedBy: { type: String },
  requestId: { type: String },
  requestFingerprint: { type: String },
  completedRequests: { type: [{ requestId: String, fingerprint: String, _id: false }], default: [] },
  pendingChange: { type: Schema.Types.Mixed },
  status: { type: String, enum: ['pending', 'applied', 'failed', 'updating', 'deleted'], required: true },
  failureReason: { type: String },
}, { timestamps: true });

BossAwardSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60, name: 'boss_award_one_year_retention' },
);
BossAwardSchema.index({ status: 1, createdAt: 1 });
BossAwardSchema.index({ requestId: 1 }, { unique: true, sparse: true });

const BossAward: Model<IBossAward> = mongoose.models.BossAward
  || mongoose.model<IBossAward>('BossAward', BossAwardSchema);

export default BossAward;
