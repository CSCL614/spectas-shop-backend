import mongoose, { Document, Schema } from 'mongoose';
import { ISupplierInvoiceProduct, ISupplierPaymentRecord } from '../types';

export interface ISupplierInvoice extends Document {
  invoiceNumber: string;
  supplierId?: mongoose.Types.ObjectId;
  supplierName: string;
  contactPerson?: string;
  mobileNumber?: string;
  invoiceDate: string;
  invoiceTime: string;
  products: ISupplierInvoiceProduct[];
  totalQuantity: number;
  frameQuantity: number;
  lensQuantity: number;
  netPrice: number;
  advanceAmount: number;
  totalPaid: number;
  balanceAmount: number;
  paymentType: string;
  paymentStatus: 'CLEARED' | 'PARTIAL' | 'PENDING';
  clearedAt?: Date;
  clearedBy?: string;
  paymentHistory: ISupplierPaymentRecord[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const SupplierInvoiceProductSchema = new Schema(
  {
    brandName: { type: String, required: true, trim: true },
    brandUniqueNumber: { type: String, required: true, trim: true, uppercase: true },
    productType: { type: String, enum: ['FRAME', 'LENS'], required: true },
    productIdentification: { type: String, default: '', trim: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    lensQuantity: { type: Number, min: 0, default: 0 },
    frameQuantity: { type: Number, min: 0, default: 0 },
    unitCost: { type: Number, min: 0, default: 0 },
    totalCost: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const SupplierPaymentRecordSchema = new Schema(
  {
    receiptNumber: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: String, required: true },
    time: { type: String, required: true },
    paymentMethod: { type: String, required: true, default: 'Cash', trim: true },
    referenceNumber: { type: String, default: '', trim: true },
    remainingBalance: { type: Number, required: true, min: 0 },
    recordedBy: { type: String, default: 'ADMIN' },
    recordedByName: { type: String, default: 'Admin' },
    notes: { type: String, default: '' },
  },
  { _id: true }
);

const SupplierInvoiceSchema = new Schema<ISupplierInvoice>(
  {
    invoiceNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    supplierName: { type: String, required: true, trim: true, index: true },
    contactPerson: { type: String, default: '', trim: true },
    mobileNumber: { type: String, default: '', trim: true },
    invoiceDate: { type: String, required: true, index: true },
    invoiceTime: { type: String, default: '12:00' },
    products: { type: [SupplierInvoiceProductSchema], default: [] },
    totalQuantity: { type: Number, required: true, min: 0, default: 0 },
    frameQuantity: { type: Number, min: 0, default: 0 },
    lensQuantity: { type: Number, min: 0, default: 0 },
    netPrice: { type: Number, required: true, min: 0, default: 0 },
    advanceAmount: { type: Number, min: 0, default: 0 },
    totalPaid: { type: Number, min: 0, default: 0 },
    balanceAmount: { type: Number, min: 0, default: 0 },
    paymentType: { type: String, default: 'Cash', trim: true },
    paymentStatus: {
      type: String,
      enum: ['CLEARED', 'PARTIAL', 'PENDING'],
      default: 'PENDING',
      index: true,
    },
    clearedAt: { type: Date },
    clearedBy: { type: String },
    paymentHistory: { type: [SupplierPaymentRecordSchema], default: [] },
    notes: { type: String, default: '', trim: true },
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

SupplierInvoiceSchema.index({ invoiceDate: -1 });

export const SupplierInvoice = mongoose.model<ISupplierInvoice>('SupplierInvoice', SupplierInvoiceSchema);
