import mongoose, { Document, Schema } from 'mongoose';
import { UserRole } from '../types';

export interface IUser extends Document {
  username: string;
  password?: string;
  email: string;
  fullName: string;
  role: UserRole;
  active: boolean;
  lastLogin?: Date;
  lastLogout?: Date;
  lastActive?: Date;
  isOnline: boolean;
  tokenVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: { type: String, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    fullName: { type: String, required: true, trim: true },
    role: { type: String, enum: ['ADMIN', 'SALESPERSON'], default: 'SALESPERSON' },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
    lastLogout: { type: Date },
    lastActive: { type: Date, default: Date.now },
    isOnline: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: any) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        return ret;
      },
    },
  }
);

export const User = mongoose.model<IUser>('User', UserSchema);
