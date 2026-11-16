import mongoose, { Document, Schema } from 'mongoose';

export interface ICustomerFeedback extends Document {
  patientName: string;
  patientPhone: string;
  orderId: string;
  rating: number; // 1 to 5
  feedback: string;
  feedbackDate: string; // YYYY-MM-DD
  salespersonId: string;
  salespersonName: string;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerFeedbackSchema = new Schema<ICustomerFeedback>(
  {
    patientName: {
      type: String,
      required: true,
      trim: true,
    },
    patientPhone: {
      type: String,
      required: true,
      trim: true,
    },
    orderId: {
      type: String,
      default: '',
      trim: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    feedback: {
      type: String,
      required: true,
      trim: true,
    },
    feedbackDate: {
      type: String,
      required: true,
    },
    salespersonId: {
      type: String,
      default: '',
      index: true,
    },
    salespersonName: {
      type: String,
      default: '',
      trim: true,
    },
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

CustomerFeedbackSchema.index({ feedbackDate: -1 });
CustomerFeedbackSchema.index({ rating: 1 });

export const CustomerFeedback = mongoose.model<ICustomerFeedback>('CustomerFeedback', CustomerFeedbackSchema);

