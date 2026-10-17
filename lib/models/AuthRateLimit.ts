import mongoose, { Schema, type Model } from 'mongoose';
interface RateLimitRecord { _id: string; count: number; expiresAt: Date }
const schema = new Schema<RateLimitRecord>({
  _id: { type: String, required: true }, count: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});
const AuthRateLimit: Model<RateLimitRecord> = mongoose.models.AuthRateLimit || mongoose.model('AuthRateLimit', schema);
export default AuthRateLimit;
