import mongoose, { Schema, type Model } from 'mongoose';
interface ClanAdministrationRecord { _id: string; revision: number; bootstrapClaimed: boolean }
const schema = new Schema<ClanAdministrationRecord>({
  _id: { type: String, required: true }, revision: { type: Number, default: 0 }, bootstrapClaimed: { type: Boolean, default: false },
});
const ClanAdministrationState: Model<ClanAdministrationRecord> = mongoose.models.ClanAdministrationState || mongoose.model('ClanAdministrationState', schema);
export default ClanAdministrationState;
