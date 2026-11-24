import mongoose, { Document, Schema } from 'mongoose';

export type MovementType =
  | 'OPENING_STOCK'
  | 'SUPPLIER_RECEIVED'
  | 'CUSTOMER_DELIVERED'
  | 'STOCK_ADJUSTMENT'
  | 'DELIVERY_REVERSED'
  | 'RETURN';

export interface IInventoryLog extends Document {
  productUniqueNumber: string;
  productId?: mongoose.Types.ObjectId;
  brandName: string;
  productType: 'FRAME' | 'LENS';
  movementType: MovementType;
  quantity: number;
  previousStock: number;
  newStock: number;
  referenceOrderNumber?: string;
  referenceInvoiceNumber?: string;
  performedBy: string;
  performedByName: string;
  notes?: string;
  date: string;
  time: string;
  createdAt: Date;
  updatedAt: Date;
}

const InventoryLogSchema = new Schema<IInventoryLog>(
  {
    productUniqueNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    brandName: { type: String, required: true, trim: true },
    productType: { type: String, enum: ['FRAME', 'LENS'], required: true },
    movementType: {
      type: String,
      enum: [
        'OPENING_STOCK',
        'SUPPLIER_RECEIVED',
        'CUSTOMER_DELIVERED',
        'STOCK_ADJUSTMENT',
        'DELIVERY_REVERSED',
        'RETURN',
      ],
      required: true,
      index: true,
    },
    quantity: { type: Number, required: true },
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },
    referenceOrderNumber: { type: String, trim: true, uppercase: true },
    referenceInvoiceNumber: { type: String, trim: true },
    performedBy: { type: String, default: 'SYSTEM', trim: true },
    performedByName: { type: String, default: 'System', trim: true },
    notes: { type: String, default: '', trim: true },
    date: { type: String, required: true, index: true },
    time: { type: String, required: true },
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

InventoryLogSchema.index({ createdAt: -1 });

export const InventoryLog = mongoose.model<IInventoryLog>('InventoryLog', InventoryLogSchema);
