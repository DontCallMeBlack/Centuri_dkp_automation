import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IBossAwardParticipant {
  rowIndex: number;
  owner: string;
  account: string;
}

export interface IBossAward extends Document {
  bossName: string;
  points: number;
  participants: IBossAwardParticipant[];
  createdBy: string;
  updatedBy?: string;
  status: 'pending' | 'applied' | 'failed' | 'updating';
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ParticipantSchema = new Schema<IBossAwardParticipant>({
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
}, { _id: false });

const BossAwardSchema: Schema<IBossAward> = new Schema({
  bossName: { type: String, required: true },
  points: { type: Number, required: true },
  participants: { type: [ParticipantSchema], default: [] },
  createdBy: { type: String, required: true },
  updatedBy: { type: String },
  status: { type: String, enum: ['pending', 'applied', 'failed', 'updating'], required: true },
  failureReason: { type: String },
}, { timestamps: true });

BossAwardSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 365 * 24 * 60 * 60, name: 'boss_award_one_year_retention' },
);

const BossAward: Model<IBossAward> = mongoose.models.BossAward
  || mongoose.model<IBossAward>('BossAward', BossAwardSchema);

export default BossAward;
