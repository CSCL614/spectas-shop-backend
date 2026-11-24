import mongoose, { Document, Schema } from 'mongoose';

export interface ISupplier extends Document {
  supplierName: string;
  contactPerson?: string;
  mobileNumber?: string;
  email?: string;
  address?: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SupplierSchema = new Schema<ISupplier>(
  {
    supplierName: { type: String, required: true, unique: true, trim: true, index: true },
    contactPerson: { type: String, default: '', trim: true },
    mobileNumber: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    address: { type: String, default: '', trim: true },
    active: { type: Boolean, default: true },
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

export const Supplier = mongoose.model<ISupplier>('Supplier', SupplierSchema);
