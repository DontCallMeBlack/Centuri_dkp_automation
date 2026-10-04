// lib/models/User.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IUser extends Document {
  nickname: string;
  passwordHash: string;
  role: 'chief' | 'general' | 'guardian' | 'clansman';
  status: 'approved' | 'pending';
  sheetRecordName?: string;
  createdAt: Date;
}

const UserSchema: Schema<IUser> = new Schema({
  nickname: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['chief', 'general', 'guardian', 'clansman'], default: 'clansman' },
  status: { type: String, enum: ['approved', 'pending'], default: 'pending' },
  sheetRecordName: { type: String, trim: true },
  createdAt: { type: Date, default: Date.now },
});

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

export default User;
                    