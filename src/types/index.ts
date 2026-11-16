import { Request } from 'express';

export type UserRole = 'ADMIN' | 'SALESPERSON';
export type DeliveryStatus = 'PENDING' | 'DELIVERED';
export type DiscountType = 'PERCENTAGE' | 'FIXED' | 'NONE';

export const PAYMENT_METHODS = [
  'Cash',
  'UPI',
  'Google Pay',
  'PhonePe',
  'Paytm',
  'Debit Card',
  'Credit Card',
  'Bank Transfer',
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


