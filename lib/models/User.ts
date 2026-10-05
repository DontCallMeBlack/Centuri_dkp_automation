// lib/models/User.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISheetRecord {
  rowIndex?: number;
  owner: string;
  account: string;
}

export interface IUser extends Document {
  nickname: string;
  passwordHash: string;
  role: 'chief' | 'general' | 'guardian' | 'clansman';
  status: 'approved' | 'pending';
  sheetRecordName?: string;
  sheetRecords?: ISheetRecord[];
  createdAt: Date;
}

const SheetRecordSchema = new Schema<ISheetRecord>({
  rowIndex: { type: Number },
  owner: { type: String, required: true, trim: true },
  account: { type: String, trim: true, default: '' },
}, { _id: false });

const UserSchema: Schema<IUser> = new Schema({
  nickname: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['chief', 'general', 'guardian', 'clansman'], default: 'clansman' },
  status: { type: String, enum: ['approved', 'pending'], default: 'pending' },
  sheetRecordName: { type: String, trim: true },
  sheetRecords: { type: [SheetRecordSchema], default: undefined },
  createdAt: { type: Date, default: Date.now },
});

UserSchema.index({ 'sheetRecords.rowIndex': 1 }, { unique: true, sparse: true });

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

export default User;
                    