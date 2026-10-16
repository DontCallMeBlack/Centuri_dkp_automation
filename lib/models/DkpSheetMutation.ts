import mongoose, { Document, Model, Schema } from 'mongoose';

export interface IDkpSheetMutation extends Document {
  spreadsheetId: string;
  operationKey: string;
  status: 'pending' | 'applied';
  updates: Array<{ range: string; values: number[][] }>;
  createdAt: Date;
  updatedAt: Date;
}

const DkpSheetMutationSchema: Schema<IDkpSheetMutation> = new Schema({
  spreadsheetId: { type: String, required: true },
  operationKey: { type: String, required: true },
  status: { type: String, enum: ['pending', 'applied'], required: true },
  updates: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true });

DkpSheetMutationSchema.index({ spreadsheetId: 1, operationKey: 1 }, { unique: true });
DkpSheetMutationSchema.index({ spreadsheetId: 1, status: 1, createdAt: 1 });

const DkpSheetMutation: Model<IDkpSheetMutation> = mongoose.models.DkpSheetMutation
  || mongoose.model<IDkpSheetMutation>('DkpSheetMutation', DkpSheetMutationSchema);

export default DkpSheetMutation;
