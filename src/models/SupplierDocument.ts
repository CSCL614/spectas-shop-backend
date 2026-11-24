import mongoose, { Document, Schema } from 'mongoose';

export type SupplierDocumentType = 'INVOICE' | 'QUOTATION';

export interface ISupplierDocument extends Document {
  supplierName: string;
  invoiceNumber: string;
  documentDate: string;
  documentType: SupplierDocumentType;
  notes?: string;
  originalFileName: string;
  fileSize: number;
  mimeType: string;
  blobPathname: string;
  blobUrl: string;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: Date;
  updatedAt: Date;
}

const SupplierDocumentSchema = new Schema<ISupplierDocument>(
  {
    supplierName: { type: String, required: true, trim: true, index: true },
    invoiceNumber: { type: String, required: true, trim: true, uppercase: true, index: true },
    documentDate: { type: String, required: true, index: true },
    documentType: {
      type: String,
      enum: ['INVOICE', 'QUOTATION'],
      default: 'INVOICE',
      required: true,
      index: true,
    },
    notes: { type: String, default: '', trim: true },
    originalFileName: { type: String, required: true, trim: true },
    fileSize: { type: Number, required: true, default: 0 },
    mimeType: { type: String, default: 'application/pdf', trim: true },
    blobPathname: { type: String, default: '', trim: true },
    blobUrl: { type: String, default: '', trim: true },
    uploadedBy: { type: String, default: 'admin', trim: true },
    uploadedByName: { type: String, default: 'Admin', trim: true },
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

SupplierDocumentSchema.index({ supplierName: 1, invoiceNumber: 1 });
SupplierDocumentSchema.index({ documentDate: -1 });
SupplierDocumentSchema.index({ createdAt: -1 });

export const SupplierDocument = mongoose.model<ISupplierDocument>(
  'SupplierDocument',
  SupplierDocumentSchema
);
