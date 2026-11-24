import { Request } from 'express';

export type UserRole = 'ADMIN' | 'SALESPERSON';
export type DeliveryStatus = 'PENDING' | 'DELIVERED';
export type DiscountType = 'PERCENTAGE' | 'FIXED' | 'NONE';
export type ProductType = 'FRAME' | 'LENS' | 'UNSPECIFIED';

export const PAYMENT_METHODS = [
  'Cash',
  'UPI',
  'Google Pay',
  'PhonePe',
  'Paytm',
  'Debit Card',
  'Credit Card',
  'Bank Transfer',
  'Cheque',
] as const;

export type PaymentMethod = typeof PAYMENT_METHODS[number];

export interface IPaymentTransaction {
  amount: number;
  paymentMethod: string;
  date: string;
  time?: string;
  notes?: string;
  receivedBy?: string;
  receivedByName?: string;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: UserRole;
  active: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

export interface ISaleItem {
  brandName: string;
  productType: 'FRAME' | 'LENS';
  brandUniqueNumber: string;
  productIdentification: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  costPrice?: number;
}

export interface ISupplierInvoiceProduct {
  brandName: string;
  brandUniqueNumber: string;
  productType: 'FRAME' | 'LENS';
  productIdentification: string;
  quantity: number;
  lensQuantity: number;
  frameQuantity: number;
  unitCost: number;
  totalCost: number;
}

export interface ISupplierPaymentRecord {
  receiptNumber: string;
  amount: number;
  date: string;
  time: string;
  paymentMethod: string;
  referenceNumber?: string;
  remainingBalance: number;
  recordedBy?: string;
  recordedByName?: string;
  notes?: string;
}
