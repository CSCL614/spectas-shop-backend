import mongoose, { Document, Schema } from 'mongoose';

export interface IProduct extends Document {
  brandName: string;
  productType: 'FRAME' | 'LENS';
  brandUniqueNumber: string;
  productIdentification: string;
  price: number;
  costPrice: number;
  quantity: number;
  frameQuantity: number;
  lensQuantity: number;
  lowStockThreshold: number;
  stockStatus: 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
  active: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProductSchema = new Schema<IProduct>(
  {
    brandName: { type: String, required: true, trim: true, index: true },
    productType: {
      type: String,
      enum: ['FRAME', 'LENS'],
      required: true,
      index: true,
    },
    brandUniqueNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    productIdentification: { type: String, default: '', trim: true },
    price: { type: Number, required: true, min: 0, default: 0 },
    costPrice: { type: Number, min: 0, default: 0 },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    frameQuantity: { type: Number, min: 0, default: 0 },
    lensQuantity: { type: Number, min: 0, default: 0 },
    lowStockThreshold: { type: Number, min: 0, default: 5 },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: 'ADMIN', trim: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: any) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        const qty = ret.quantity || 0;
        const thresh = ret.lowStockThreshold ?? 5;
        if (qty <= 0) {
          ret.stockStatus = 'OUT_OF_STOCK';
        } else if (qty <= thresh) {
          ret.stockStatus = 'LOW_STOCK';
        } else {
          ret.stockStatus = 'IN_STOCK';
        }
        ret.frameQuantity = ret.productType === 'FRAME' ? qty : 0;
        ret.lensQuantity = ret.productType === 'LENS' ? qty : 0;
        return ret;
      },
    },
  }
);

ProductSchema.index({ brandName: 1, productType: 1 });
ProductSchema.index({ quantity: 1 });

export const Product = mongoose.model<IProduct>('Product', ProductSchema);
