import { Response } from 'express';
import { AuthRequest } from '../types';
import { CustomerFeedback } from '../models/CustomerFeedback';
import { Sale } from '../models/Sale';
import { AuditLog } from '../models/AuditLog';

export const createFeedback = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { patientName, patientPhone, orderId, rating, feedback, feedbackDate } = req.body;

    if (!patientName || !patientPhone || !rating || !feedback) {
      res.status(400).json({
        success: false,
        message: 'Patient name, phone number, rating, and feedback comments are required',
        data: null,
      });
      return;
    }

    const numRating = Math.max(1, Math.min(5, parseInt(String(rating), 10)));
    const todayStr = feedbackDate ? String(feedbackDate).trim() : new Date().toISOString().split('T')[0];

    let targetSalespersonId = req.user?.id || '';
    let targetSalespersonName = req.user?.fullName || '';

    // If orderId is provided, normalize to STK- format and find matching sale
    let formattedOrderId = orderId ? String(orderId).trim().toUpperCase() : '';
    if (formattedOrderId && /^\d+$/.test(formattedOrderId)) {
      formattedOrderId = `STK-${formattedOrderId}`;
    }

    if (formattedOrderId) {
      const numericOnly = formattedOrderId.replace(/^STK-/i, '');
      const sale = await Sale.findOne({
        $or: [
          { stickerNumber: formattedOrderId },
          { stickerNumber: numericOnly },
          { _id: formattedOrderId.length === 24 ? formattedOrderId : null },
        ],
      });
      if (sale) {
        formattedOrderId = sale.stickerNumber;
        targetSalespersonId = sale.salespersonId;
        targetSalespersonName = sale.salespersonName;
      }
    }

    const newFeedback = await CustomerFeedback.create({
      patientName: String(patientName).trim(),
      patientPhone: String(patientPhone).trim(),
      orderId: formattedOrderId,
      rating: numRating,
      feedback: String(feedback).trim(),
      feedbackDate: todayStr,
      salespersonId: targetSalespersonId,
      salespersonName: targetSalespersonName,
    });

    await AuditLog.create({
      action: 'CREATE_FEEDBACK',
      entityType: 'FEEDBACK',
      entityId: newFeedback._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Submitted ${numRating}-star feedback for patient ${newFeedback.patientName}`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: 'Feedback submitted successfully',
      data: newFeedback.toJSON(),
    });
  } catch (error: any) {
    console.error('createFeedback error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getAllFeedback = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '10'), 10)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const rating = req.query.rating ? parseInt(String(req.query.rating), 10) : 0;
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};

    // Role-based access: Salespersons only see feedback for their orders
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    }

    if (rating >= 1 && rating <= 5) {
      query.rating = rating;
    }

    if (dateFrom && dateTo) {
      query.feedbackDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.feedbackDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.feedbackDate = { $lte: dateTo };
    }

    if (search) {
      const regex = { $regex: search, $options: 'i' };
      const orderIdPatterns: any[] = [{ orderId: regex }];
      if (/^\d+$/.test(search.trim())) {
        orderIdPatterns.push({ orderId: { $regex: `STK-${search.trim()}`, $options: 'i' } });
      }
      const stkMatch = search.trim().match(/^STK-?(\d+)$/i);
      if (stkMatch) {
        orderIdPatterns.push({ orderId: stkMatch[1] });
      }
      query.$or = [
        { patientName: regex },
        { patientPhone: regex },
        ...orderIdPatterns,
        { feedback: regex },
      ];
    }

    const totalElements = await CustomerFeedback.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);

    const feedbackList = await CustomerFeedback.find(query)
      .sort({ createdAt: -1 })
      .skip(page * size)
      .limit(size);

    res.json({
      success: true,
      message: 'Customer feedback retrieved',
      data: {
        content: feedbackList.map((f) => f.toJSON()),
        page,
        size,
        totalElements,
        totalPages,
        last: page >= totalPages - 1,
      },
    });
  } catch (error: any) {
    console.error('getAllFeedback error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const deleteFeedback = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const feedback = await CustomerFeedback.findById(req.params.id);
    if (!feedback) {
      res.status(404).json({ success: false, message: 'Feedback not found', data: null });
      return;
    }

    await CustomerFeedback.findByIdAndDelete(req.params.id);

    await AuditLog.create({
      action: 'DELETE_FEEDBACK',
      entityType: 'FEEDBACK',
      entityId: feedback._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Deleted feedback from ${feedback.patientName}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Feedback deleted successfully', data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getFeedbackStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const query: any = {};
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    }

    const allFeedback = await CustomerFeedback.find(query);
    const totalCount = allFeedback.length;

    let sumRating = 0;
    const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    for (const f of allFeedback) {
      sumRating += f.rating;
      if (f.rating >= 1 && f.rating <= 5) {
        ratingCounts[f.rating as 1 | 2 | 3 | 4 | 5] += 1;
      }
    }

    const averageRating = totalCount > 0 ? parseFloat((sumRating / totalCount).toFixed(1)) : 0;

    res.json({
      success: true,
      message: 'Feedback statistics calculated',
      data: {
        totalCount,
        averageRating,
        ratingCounts,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

