import mongoose, { Schema, type Model, type Types } from 'mongoose';
interface AuthSessionRecord { _id: string; userId: Types.ObjectId; expiresAt: Date; createdAt: Date }
const schema = new Schema<AuthSessionRecord>({
  _id: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  createdAt: { type: Date, default: Date.now },
});
const AuthSession: Model<AuthSessionRecord> = mongoose.models.AuthSession || mongoose.model('AuthSession', schema);
export default AuthSession;
