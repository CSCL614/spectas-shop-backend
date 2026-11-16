import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, AuthenticatedUser } from '../types';
import { User } from '../models/User';

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        message: 'Full authentication is required to access this resource',
        data: null,
      });
      return;
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET || 'SpectaclesShopSuperSecretKeyForJWTAuthenticationMinimum256BitsLong2024';

    const decoded = jwt.verify(token, secret) as any;
    if (!decoded || !decoded.id) {
      res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
        data: null,
      });
      return;
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      res.status(401).json({
        success: false,
        message: 'User no longer exists',
        data: null,
      });
      return;
    }

    if (!user.active) {
      res.status(403).json({
        success: false,
        message: 'User account has been deactivated. Contact administrator.',
        data: null,
      });
      return;
    }

    if (decoded.tokenVersion !== undefined && user.tokenVersion !== undefined && decoded.tokenVersion < user.tokenVersion) {
      res.status(401).json({
        success: false,
        message: 'Your session has been invalidated because your credentials changed. Please log in again.',
        data: null,
      });
      return;
    }

    req.user = {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      active: user.active,
    };

    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid token',
      data: null,
    });
  }
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> | void => {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({
      success: false,
      message: 'Access denied: Administrator privileges required',
      data: null,
    });
    return;
  }
  next();
};

