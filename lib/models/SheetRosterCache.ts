import mongoose, { Model, Schema } from 'mongoose';
import type { ReadableRosterRecord } from '../sheetRoster';

export interface ISheetRosterRecord extends ReadableRosterRecord {}

export interface ISheetRosterCache extends mongoose.Document {
  cacheKey: string;
  roster: ISheetRosterRecord[];
  fetchedAt: Date;
  refreshLockUntil: Date;
  generation: number;
  lastRefreshError?: string;
  weeklyResetFor?: Date;
  weeklyResetLockUntil: Date;
  weeklyResetLockId?: string;
  weeklyResetPending?: {
    cycleStart: Date;
    updates: Array<{ range: string; values: number[][] }>;
    previousValues?: Array<{ range: string; values: number[][] }>;
    identities?: Array<{ rowIndex: number; owner: string; account: string }>;
    weeklyActivityHistory?: Array<{ rowIndex: number; owner: string; account: string; weeks: number[] }>;
  };
  weeklyActivityHistory?: Array<{ rowIndex: number; owner: string; account: string; weeks: number[] }>;
}

const SheetRosterRecordSchema = new Schema<ISheetRosterRecord>({
  rowIndex: { type: Number, required: true },
  owner: { type: String, required: true },
  account: { type: String, default: '' },
  subClass: { type: String, default: '' },
  weeklyEarned: { type: Number, default: null },
  weeklySpent: { type: Number, default: null },
  earned: { type: Number, default: null },
  spent: { type: Number, default: null },
  available: { type: Number, default: null },
  fiveWeekActivity: { type: Number, default: null },
  dkpIssues: { type: [{ field: String, cell: String, value: String, message: String, _id: false }], default: [] },
}, { _id: false });

const SheetRosterCacheSchema: Schema<ISheetRosterCache> = new Schema({
  cacheKey: { type: String, required: true, unique: true },
  roster: { type: [SheetRosterRecordSchema], default: [] },
  fetchedAt: { type: Date, required: true, default: () => new Date(0) },
  refreshLockUntil: { type: Date, required: true, default: () => new Date(0) },
  generation: { type: Number, required: true, default: 0 },
  lastRefreshError: { type: String },
  weeklyResetFor: { type: Date },
  weeklyResetLockUntil: { type: Date, required: true, default: () => new Date(0) },
  weeklyResetLockId: { type: String },
  weeklyResetPending: { type: Schema.Types.Mixed },
  weeklyActivityHistory: { type: Schema.Types.Mixed },
}, { timestamps: true });

const SheetRosterCache: Model<ISheetRosterCache> = mongoose.models.SheetRosterCache
  || mongoose.model<ISheetRosterCache>('SheetRosterCache', SheetRosterCacheSchema);

export default SheetRosterCache;
