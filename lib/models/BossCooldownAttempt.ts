import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IBossCooldownAttempt extends Document {
  requestId: string;
  bossName: string;
  actorUserId: string;
  actorNickname: string;
  actorRole: string;
  attemptedAt: Date;
  cooldownExpiresAt: Date;
  createdAt: Date;
}

const BossCooldownAttemptSchema: Schema<IBossCooldownAttempt> = new Schema({
  requestId: { type: String, required: true },
  bossName: { type: String, required: true },
  actorUserId: { type: String, required: true },
  actorNickname: { type: String, required: true },
  actorRole: { type: String, required: true },
  attemptedAt: { type: Date, required: true },
  cooldownExpiresAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

BossCooldownAttemptSchema.index({ requestId: 1 }, { unique: true, name: 'boss_cooldown_attempt_request_unique' });
BossCooldownAttemptSchema.index({ bossName: 1, attemptedAt: -1 }, { name: 'boss_cooldown_attempt_boss_history' });
BossCooldownAttemptSchema.index({ attemptedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'boss_cooldown_attempt_retention' });

const BossCooldownAttempt: Model<IBossCooldownAttempt> = mongoose.models.BossCooldownAttempt
  || mongoose.model<IBossCooldownAttempt>('BossCooldownAttempt', BossCooldownAttemptSchema);

export default BossCooldownAttempt;
