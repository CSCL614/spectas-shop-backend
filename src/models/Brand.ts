import mongoose, { Document, Schema } from 'mongoose';

export interface IBrand extends Document {
  name: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BrandSchema = new Schema<IBrand>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    createdBy: { type: String, default: 'SYSTEM', trim: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: any) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const Brand = mongoose.model<IBrand>('Brand', BrandSchema);
