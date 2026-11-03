import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IBossCooldown extends Document {
  bossName: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BossCooldownSchema: Schema<IBossCooldown> = new Schema({
  bossName: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

BossCooldownSchema.index({ bossName: 1 }, { unique: true, name: 'boss_cooldown_name_unique' });
BossCooldownSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'boss_cooldown_expiry' });

const BossCooldown: Model<IBossCooldown> = mongoose.models.BossCooldown
  || mongoose.model<IBossCooldown>('BossCooldown', BossCooldownSchema);

export default BossCooldown;
