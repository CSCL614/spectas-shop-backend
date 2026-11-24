import mongoose, { Document, Schema } from 'mongoose';
import { DeliveryStatus, DiscountType, IPaymentTransaction, ISaleItem } from '../types';

export interface ISale extends Document {
  stickerNumber: string;
  companyName: string;
  productType: 'FRAME' | 'LENS' | 'UNSPECIFIED';
  items: ISaleItem[];
  stockDeducted: boolean;
  costPrice: number;
  originalSellingPrice: number;
  discountType: DiscountType;
  discountValue: number;
  discountAmount: number;
  sellingPrice: number;
  advanceAmount: number;
  remainingBalance: number;
  grossProfit: number;
  paymentMethod: string;
  paymentTransactions: IPaymentTransaction[];
  expectedDeliveryDate: string;
  deliveryStatus: DeliveryStatus;
  deliveredAt?: Date;
  deliveredBy?: string;
  customerName: string;
  customerMobile: string;
  saleDate: string;
  salespersonId: string;
  salespersonName: string;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentTransactionSchema = new Schema(
  {
    amount: { type: Number, required: true, default: 0 },
    paymentMethod: { type: String, required: true, default: 'Cash' },
    date: { type: String, required: true },
    time: { type: String },
    notes: { type: String },
    receivedBy: { type: String },
    receivedByName: { type: String },
  },
  { _id: true }
);

const SaleItemSchema = new Schema(
  {
    brandName: { type: String, required: true, trim: true },
    productType: { type: String, enum: ['FRAME', 'LENS'], required: true },
    brandUniqueNumber: { type: String, required: true, trim: true, uppercase: true },
    productIdentification: { type: String, default: '', trim: true },
    quantity: { type: Number, required: true, min: 1, default: 1 },
    unitPrice: { type: Number, required: true, min: 0, default: 0 },
    totalPrice: { type: Number, required: true, min: 0, default: 0 },
    costPrice: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const SaleSchema = new Schema<ISale>(
  {
    stickerNumber: { type: String, required: true, unique: true, trim: true, uppercase: true },
    companyName: { type: String, required: true, trim: true },
    productType: {
      type: String,
      enum: ['FRAME', 'LENS', 'UNSPECIFIED'],
      default: 'UNSPECIFIED',
    },
    items: { type: [SaleItemSchema], default: [] },
    stockDeducted: { type: Boolean, default: false },
    costPrice: { type: Number, required: true, default: 0 },
    originalSellingPrice: { type: Number, required: true, default: 0 },
    discountType: {
      type: String,
      enum: ['PERCENTAGE', 'FIXED', 'NONE'],
      default: 'NONE',
    },
    discountValue: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    sellingPrice: { type: Number, required: true, default: 0 },
    advanceAmount: { type: Number, required: true, default: 0 },
    remainingBalance: { type: Number, required: true, default: 0 },
    grossProfit: { type: Number, required: true, default: 0 },
    paymentMethod: { type: String, required: true, default: 'Cash', trim: true },
    paymentTransactions: { type: [PaymentTransactionSchema], default: [] },
    expectedDeliveryDate: { type: String, required: true },
    deliveryStatus: {
      type: String,
      enum: ['PENDING', 'DELIVERED'],
      default: 'PENDING',
    },
    deliveredAt: { type: Date },
    deliveredBy: { type: String, trim: true },
    customerName: { type: String, required: true, trim: true },
    customerMobile: { type: String, required: true, trim: true },
    saleDate: { type: String, required: true },
    salespersonId: { type: String, required: true, index: true },
    salespersonName: { type: String, required: true, trim: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: any) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        if (ret.originalSellingPrice === undefined || ret.originalSellingPrice === null || ret.originalSellingPrice === 0) {
          ret.originalSellingPrice = ret.sellingPrice;
        }
        if (!ret.productType) ret.productType = 'UNSPECIFIED';
        if (!ret.discountType) ret.discountType = 'NONE';
        if (ret.discountValue === undefined) ret.discountValue = 0;
        if (ret.discountAmount === undefined) ret.discountAmount = 0;
        if (!ret.paymentMethod) ret.paymentMethod = 'Cash';
        if (!ret.paymentTransactions) ret.paymentTransactions = [];

        // Backward compatibility: If items array is empty, construct one line item from legacy fields
        if (!ret.items || ret.items.length === 0) {
          ret.items = [
            {
              brandName: ret.companyName || 'Optical Brand',
              productType: ret.productType === 'LENS' ? 'LENS' : 'FRAME',
              brandUniqueNumber: ret.stickerNumber || 'N/A',
              productIdentification: `${ret.companyName || 'Optical'} (${ret.productType || 'FRAME'})`,
              quantity: 1,
              unitPrice: ret.originalSellingPrice || ret.sellingPrice || 0,
              totalPrice: ret.originalSellingPrice || ret.sellingPrice || 0,
              costPrice: ret.costPrice || 0,
            },
          ];
        }

        return ret;
      },
    },
  }
);

SaleSchema.index({ saleDate: 1 });
SaleSchema.index({ deliveryStatus: 1 });
SaleSchema.index({ paymentMethod: 1 });
SaleSchema.index({ productType: 1 });
SaleSchema.index({ stockDeducted: 1 });

export const Sale = mongoose.model<ISale>('Sale', SaleSchema);
