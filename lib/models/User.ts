// lib/models/User.ts
import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IUser extends Document {
  nickname: string;
    passwordHash: string;
      role: 'chief' | 'clansman';
        status: 'approved' | 'pending';
          createdAt: Date;
          }

          const UserSchema: Schema<IUser> = new Schema({
            nickname: { type: String, required: true, unique: true },
              passwordHash: { type: String, required: true },
                role: { type: String, enum: ['chief', 'clansman'], default: 'clansman' },
                  status: { type: String, enum: ['approved', 'pending'], default: 'pending' },
                    createdAt: { type: Date, default: Date.now },
                    });

                    const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

                    export default User;
                    