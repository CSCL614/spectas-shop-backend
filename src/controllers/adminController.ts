import { Response } from 'express';
import bcrypt from 'bcryptjs';
import { AuthRequest } from '../types';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { Sale } from '../models/Sale';

export const getUsers = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await User.find().sort({ createdAt: 1 });
    res.json({ success: true, message: 'All users retrieved', data: users.map((u) => u.toJSON()) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getSalespersons = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const users = await User.find({ role: 'SALESPERSON' }).sort({ fullName: 1 });
    res.json({ success: true, message: 'Salespersons retrieved', data: users.map((u) => u.toJSON()) });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const createUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fullName, username, email, password, role } = req.body;
    if (!fullName || !username || !email || !password) {
      res.status(400).json({ success: false, message: 'All fields are required', data: null });
      return;
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const existing = await User.findOne({ username: cleanUsername });
    if (existing) {
      res.status(400).json({ success: false, message: `Username "${cleanUsername}" already exists`, data: null });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const assignedRole = role === 'SALESPERSON' ? 'SALESPERSON' : 'ADMIN';

    const newUser = await User.create({
      fullName: String(fullName).trim(),
      username: cleanUsername,
      email: String(email).trim().toLowerCase(),
      password: hashedPassword,
      role: assignedRole,
      active: true,
    });

    await AuditLog.create({
      action: 'CREATE_USER',
      entityType: 'USER',
      entityId: newUser._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'Admin',
      details: `Created ${assignedRole}: ${newUser.username} (${newUser.fullName})`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ success: true, message: 'User created successfully', data: newUser.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const updateUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fullName, email, role } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }

    if (fullName) user.fullName = String(fullName).trim();
    if (email) user.email = String(email).trim().toLowerCase();
    if (role && (role === 'ADMIN' || role === 'SALESPERSON')) user.role = role;

    await user.save();

    await AuditLog.create({
      action: 'UPDATE_USER',
      entityType: 'USER',
      entityId: user._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'Admin',
      details: `Updated ${user.role} account: ${user.username}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: `User ${user.username} updated`, data: user.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const deleteUser = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }

    await User.findByIdAndDelete(req.params.id);

    await AuditLog.create({
      action: 'DELETE_USER',
      entityType: 'USER',
      entityId: user._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'Admin',
      details: `Deleted ${user.role} account: ${user.username}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: `Account ${user.username} deleted`, data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const adminResetPassword = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      res.status(400).json({ success: false, message: 'Password must be at least 6 characters long', data: null });
      return;
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.isOnline = false;
    user.lastLogout = new Date();
    await user.save();

    await AuditLog.create({
      action: 'ADMIN_RESET_PASSWORD',
      entityType: 'USER',
      entityId: user._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'Admin',
      details: `Password reset by Admin for ${user.fullName} (@${user.username})`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: `Password for ${user.fullName} updated successfully`, data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const toggleStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found', data: null });
      return;
    }
    user.active = !user.active;
    await user.save();

    await AuditLog.create({
      action: user.active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
      entityType: 'USER',
      entityId: user._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Status changed to ${user.active} for ${user.username}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: `User ${user.active ? 'activated' : 'deactivated'}`, data: user.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getAuditLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '25'), 10)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const action = req.query.action ? String(req.query.action).trim() : '';
    const entityType = req.query.entityType ? String(req.query.entityType).trim() : '';
    const userId = req.query.userId ? String(req.query.userId).trim() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};
    if (action && action !== 'ALL') query.action = action;
    if (entityType && entityType !== 'ALL') query.entityType = entityType;
    if (userId && userId !== 'ALL') query.performedBy = userId;

    if (dateFrom && dateTo) {
      query.timestamp = { $gte: dateFrom, $lte: dateTo + 'T23:59:59.999Z' };
    } else if (dateFrom) {
      query.timestamp = { $gte: dateFrom };
    } else if (dateTo) {
      query.timestamp = { $lte: dateTo + 'T23:59:59.999Z' };
    }

    if (search) {
      const regex = { $regex: search, $options: 'i' };
      query.$or = [{ details: regex }, { performedByName: regex }, { action: regex }];
    }

    const totalElements = await AuditLog.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);

    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .skip(page * size)
      .limit(size);

    const salespersons = await User.find({ role: 'SALESPERSON' }).lean();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const salesExecutiveSessions = await Promise.all(
      salespersons.map(async (sp) => {
        const lastActiveDate = sp.lastActive ? new Date(sp.lastActive) : null;
        const lastLoginDate = sp.lastLogin ? new Date(sp.lastLogin) : null;
        const lastLogoutDate = sp.lastLogout ? new Date(sp.lastLogout) : null;

        const hasLoggedOut = Boolean(lastLogoutDate && lastLoginDate && lastLogoutDate >= lastLoginDate);
        const isActiveWithinTimeout = Boolean(lastActiveDate && lastActiveDate > fiveMinutesAgo);
        const isOnline = Boolean(sp.isOnline && !hasLoggedOut && isActiveWithinTimeout);

        const orderCount = await Sale.countDocuments({ salespersonId: sp._id.toString() });
        const orders = await Sale.find({ salespersonId: sp._id.toString() }).select('sellingPrice');
        const totalSalesVal = orders.reduce((acc, o) => acc + (o.sellingPrice || 0), 0);

        let sessionDuration = '-';
        if (lastLoginDate) {
          const end = hasLoggedOut
            ? lastLogoutDate!
            : (isActiveWithinTimeout ? new Date() : (lastActiveDate || lastLoginDate));
          const diffMs = Math.max(0, end.getTime() - lastLoginDate.getTime());
          const diffMin = Math.round(diffMs / 60000);
          sessionDuration = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `${diffMin} mins`;
        }

        return {
          id: sp._id.toString(),
          fullName: sp.fullName,
          username: sp.username,
          email: sp.email,
          isOnline,
          lastActive: sp.lastActive ? new Date(sp.lastActive).toISOString() : null,
          lastLogin: sp.lastLogin ? new Date(sp.lastLogin).toISOString() : null,
          lastLogout: sp.lastLogout ? new Date(sp.lastLogout).toISOString() : null,
          sessionDuration,
          totalOrders: orderCount,
          totalRevenue: totalSalesVal,
        };
      })
    );

    res.json({
      success: true,
      message: 'Audit logs retrieved',
      data: {
        content: logs.map((l) => l.toJSON()),
        totalElements,
        totalPages,
        page,
        size,
        salesExecutiveSessions,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};
