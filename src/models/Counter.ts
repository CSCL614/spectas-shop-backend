import mongoose, { Document, Schema } from 'mongoose';

export interface ICounter extends Document<string> {
  _id: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 1000 },
  },
  { versionKey: false, _id: false }
);

export const Counter = mongoose.model<ICounter>('Counter', CounterSchema);
