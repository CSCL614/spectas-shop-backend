import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';

export const login = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ success: false, message: 'Username and password are required', data: null });
      return;
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const user = await User.findOne({ username: cleanUsername });

    if (!user) {
      res.status(401).json({ success: false, message: 'Invalid username or password', data: null });
      return;
    }

    if (!user.active) {
      res.status(403).json({ success: false, message: 'Your account is deactivated. Please contact an administrator.', data: null });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password || '');
    if (!isMatch) {
      res.status(401).json({ success: false, message: 'Invalid username or password', data: null });
      return;
    }

    const now = new Date();
    user.lastLogin = now;
    user.lastActive = now;
    user.isOnline = true;
    await user.save();

    await AuditLog.create({
      action: 'LOGIN',
      entityType: 'AUTH',
      entityId: user._id.toString(),
      performedBy: user._id.toString(),
      performedByName: user.fullName,
      details: `User logged in (${user.role}) at ${now.toLocaleTimeString()}`,
      timestamp: now.toISOString(),
    });

    const secret = process.env.JWT_SECRET || 'SpectaclesShopSuperSecretKeyForJWTAuthenticationMinimum256BitsLong2024';
    const expiresInMs = parseInt(process.env.JWT_EXPIRES_IN || '86400000', 10);

    const token = jwt.sign(
      { id: user._id.toString(), username: user.username, role: user.role, tokenVersion: user.tokenVersion || 0 },
      secret,
      { expiresIn: Math.floor(expiresInMs / 1000) }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        id: user._id.toString(),
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        expiresIn: expiresInMs,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'An internal error occurred during login', data: null });
  }
};

export const logout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user) {
      const user = await User.findById(req.user.id);
      if (user) {
        const now = new Date();
        user.lastLogout = now;
        user.isOnline = false;
        await user.save();

        await AuditLog.create({
          action: 'LOGOUT',
          entityType: 'AUTH',
          entityId: user._id.toString(),
          performedBy: user._id.toString(),
          performedByName: user.fullName,
          details: `User logged out at ${now.toLocaleTimeString()}`,
          timestamp: now.toISOString(),
        });
      }
    }
    res.json({ success: true, message: 'Logged out successfully', data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const heartbeat = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user?.id) {
      await User.findByIdAndUpdate(req.user.id, {
        lastActive: new Date(),
        isOnline: true,
      });
    }
    res.json({ success: true, data: { status: 'alive' } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const me = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Not authenticated', data: null });
      return;
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }
    res.json({ success: true, message: 'Current user retrieved', data: user.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized', data: null });
      return;
    }
    if (req.user.role !== 'ADMIN') {
      res.status(403).json({
        success: false,
        message: 'Access denied: Only Administrators are permitted to change passwords.',
        data: null,
      });
      return;
    }
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ success: false, message: 'Current password and new password are required', data: null });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ success: false, message: 'New password must be at least 6 characters long', data: null });
      return;
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }
    const isMatch = await bcrypt.compare(currentPassword, user.password || '');
    if (!isMatch) {
      res.status(400).json({ success: false, message: 'Current password does not match', data: null });
      return;
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    await AuditLog.create({
      action: 'PASSWORD_CHANGE',
      entityType: 'USER',
      entityId: user._id.toString(),
      performedBy: user._id.toString(),
      performedByName: user.fullName,
      details: 'Password updated successfully',
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Password changed successfully', data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};
