import { Response } from 'express';
import { AuthRequest } from '../types';
import { User } from '../models/User';

export const getSalespersons = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const salespersons = await User.find({ role: 'SALESPERSON', active: true }).sort({ fullName: 1 });
    res.json({
      success: true,
      message: 'Active salespersons list',
      data: salespersons.map((s) => s.toJSON()),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

