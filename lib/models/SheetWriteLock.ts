import mongoose, { Model, Schema } from 'mongoose';

export interface ISheetWriteLock {
  lockUntil: Date;
  token?: string;
}

const SheetWriteLockSchema = new Schema<ISheetWriteLock & { _id: string }>({
  _id: { type: String, required: true },
  lockUntil: { type: Date, required: true, default: () => new Date(0) },
  token: { type: String },
}, { versionKey: false });

const SheetWriteLock: Model<ISheetWriteLock & { _id: string }> = mongoose.models.SheetWriteLock
  || mongoose.model<ISheetWriteLock & { _id: string }>('SheetWriteLock', SheetWriteLockSchema);

export default SheetWriteLock;
