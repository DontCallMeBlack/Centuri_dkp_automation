import mongoose, { Document, Model, Schema } from 'mongoose';

export type ClanAuditEventType = 'promotion' | 'demotion' | 'member-removal';

export interface IClanAuditEvent extends Document {
  eventType: ClanAuditEventType;
  actorUserId: mongoose.Types.ObjectId;
  actorNickname: string;
  actorRole: string;
  targetUserId: mongoose.Types.ObjectId;
  targetNickname: string;
  previousRole: string;
  newRole?: string;
  createdAt: Date;
}

const ClanAuditEventSchema: Schema<IClanAuditEvent> = new Schema({
  eventType: {
    type: String,
    enum: ['promotion', 'demotion', 'member-removal'],
    required: true,
  },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  actorNickname: { type: String, required: true },
  actorRole: { type: String, required: true },
  targetUserId: { type: Schema.Types.ObjectId, required: true },
  targetNickname: { type: String, required: true },
  previousRole: { type: String, required: true },
  newRole: { type: String },
}, { timestamps: { createdAt: true, updatedAt: false } });

ClanAuditEventSchema.index({ createdAt: -1 });

const ClanAuditEvent: Model<IClanAuditEvent> = mongoose.models.ClanAuditEvent
  || mongoose.model<IClanAuditEvent>('ClanAuditEvent', ClanAuditEventSchema);

export default ClanAuditEvent;
