import mongoose, { Document, Schema } from 'mongoose';

export interface IUploadedFile extends Document {
  originalFileName: string;
  storedFileName: string;
  blobPathname: string;
  blobUrl: string;
  storageProvider: 'VERCEL_BLOB' | 'LOCAL';
  filePath?: string;
  fileSize: number;
  mimeType: string;
  salespersonId: string;
  salespersonName: string;
  uploadDate: string;
  uploadTime: string;
  totalRows: number;
  successCount: number;
  errorCount: number;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  createdAt: Date;
  updatedAt: Date;
}

const UploadedFileSchema = new Schema<IUploadedFile>(
  {
    originalFileName: { type: String, required: true, trim: true },
    storedFileName: { type: String, required: true, trim: true },
    blobPathname: { type: String, default: '', trim: true, index: true },
    blobUrl: { type: String, default: '', trim: true },
    storageProvider: {
      type: String,
      enum: ['VERCEL_BLOB', 'LOCAL'],
      default: 'VERCEL_BLOB',
    },
    filePath: { type: String, default: '' },
    fileSize: { type: Number, default: 0 },
    mimeType: {
      type: String,
      default: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    salespersonId: { type: String, required: true, index: true },
    salespersonName: { type: String, required: true, trim: true },
    uploadDate: { type: String, required: true },
    uploadTime: { type: String, required: true },
    totalRows: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    status: { type: String, enum: ['SUCCESS', 'PARTIAL', 'FAILED'], default: 'SUCCESS' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: any) {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        // Keep internal disk path hidden from API responses
        delete ret.filePath;
        return ret;
      },
    },
  }
);

UploadedFileSchema.index({ uploadDate: -1 });
UploadedFileSchema.index({ createdAt: -1 });

export const UploadedFile = mongoose.model<IUploadedFile>('UploadedFile', UploadedFileSchema);
