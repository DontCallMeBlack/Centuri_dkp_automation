// lib/models/User.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export type UserRole = 'chief' | 'general' | 'guardian' | 'clansman';
export type UserStatus = 'approved' | 'pending';

export interface IUser extends Document {
  nickname: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  linkedRosterRow?: number;
  linkedRosterOwner?: string;
  linkedRosterAccount?: string;
  linkedRosterSubClass?: string;
  createdAt: Date;
}

const UserSchema: Schema<IUser> = new Schema({
  nickname: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['chief', 'general', 'guardian', 'clansman'], default: 'clansman' },
  status: { type: String, enum: ['approved', 'pending'], default: 'pending' },
  linkedRosterRow: { type: Number },
  linkedRosterOwner: { type: String },
  linkedRosterAccount: { type: String },
  linkedRosterSubClass: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

export default User;