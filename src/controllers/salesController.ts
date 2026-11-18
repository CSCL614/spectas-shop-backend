import { Response } from 'express';
import { AuthRequest, IPaymentTransaction, DiscountType, DeliveryStatus } from '../types';
import { Sale, ISale } from '../models/Sale';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { Counter } from '../models/Counter';
import { CustomerFeedback } from '../models/CustomerFeedback';

export const getIndianDateStr = (d: Date = new Date()): string => {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

export const getNextAtomicStickerNumber = async (): Promise<string> => {
  // 1. Scan existing sales to find highest numeric sticker number
  const sales = await Sale.find().select('stickerNumber').lean();
  let maxFound = 0;
  for (const s of sales) {
    if (!s.stickerNumber) continue;
    const digits = s.stickerNumber.match(/\d+/g);
    if (digits && digits.length > 0) {
      const num = parseInt(digits[digits.length - 1], 10);
      if (!isNaN(num) && num > maxFound) {
        maxFound = num;
      }
    }
  }

  // 2. Fetch or update atomic counter
  let counter = await Counter.findById('stickerNumber');
  if (!counter) {
    const initialSeq = Math.max(1000, maxFound);
    counter = await Counter.create({ _id: 'stickerNumber', seq: initialSeq });
  } else if (counter.seq < maxFound) {
    counter.seq = maxFound;
    await counter.save();
  }

  const updatedCounter = await Counter.findByIdAndUpdate(
    'stickerNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );

  return `STK-${updatedCounter.seq}`;
};

export const getNextStickerNumberPreview = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sales = await Sale.find().select('stickerNumber').lean();
    let maxFound = 0;
    for (const s of sales) {
      if (!s.stickerNumber) continue;
      const digits = s.stickerNumber.match(/\d+/g);
      if (digits && digits.length > 0) {
        const num = parseInt(digits[digits.length - 1], 10);
        if (!isNaN(num) && num > maxFound) {
          maxFound = num;
        }
      }
    }

    const counter = await Counter.findById('stickerNumber');
    const currentSeq = counter ? counter.seq : 1000;
    const nextNum = Math.max(currentSeq, maxFound) + 1;

    res.json({
      success: true,
      message: 'Next sequential sticker number preview',
      data: { nextStickerNumber: `STK-${nextNum}` },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getAllSales = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '10'), 10)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const deliveryStatus = req.query.deliveryStatus ? String(req.query.deliveryStatus).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const balanceStatus = req.query.balanceStatus ? String(req.query.balanceStatus).trim().toUpperCase() : '';
    const salespersonId = req.query.salespersonId ? String(req.query.salespersonId).trim() : '';
    const companyName = req.query.companyName ? String(req.query.companyName).trim() : '';
    const paymentMethod = req.query.paymentMethod ? String(req.query.paymentMethod).trim() : '';
    const hasDiscount = req.query.hasDiscount ? String(req.query.hasDiscount).trim() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};

    // Role-based data isolation
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    } else if (salespersonId) {
      query.salespersonId = salespersonId;
    }

    if (deliveryStatus && (deliveryStatus === 'PENDING' || deliveryStatus === 'DELIVERED')) {
      query.deliveryStatus = deliveryStatus;
    }

    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query.productType = productType;
    }

    if (balanceStatus === 'CLEARED') {
      query.remainingBalance = 0;
    } else if (balanceStatus === 'PARTIAL') {
      query.remainingBalance = { $gt: 0 };
      query.advanceAmount = { $gt: 0 };
    } else if (balanceStatus === 'PENDING') {
      query.advanceAmount = 0;
      query.remainingBalance = { $gt: 0 };
    }

    if (paymentMethod) {
      query.paymentMethod = paymentMethod;
    }

    if (hasDiscount === 'true') {
      query.discountAmount = { $gt: 0 };
    } else if (hasDiscount === 'false') {
      query.$or = [{ discountAmount: 0 }, { discountAmount: { $exists: false } }];
    }

    if (companyName) {
      query.companyName = { $regex: companyName, $options: 'i' };
    }

    if (dateFrom && dateTo) {
      query.saleDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.saleDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.saleDate = { $lte: dateTo };
    }

    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      // Support searching by both STK-1016 and 1016 formats
      const stickerSearchPatterns: any[] = [
        { stickerNumber: searchRegex },
      ];
      // If user searches for a plain number like 1016, also match STK-1016
      if (/^\d+$/.test(search.trim())) {
        stickerSearchPatterns.push({ stickerNumber: { $regex: `STK-${search.trim()}`, $options: 'i' } });
      }
      // If user searches for STK-1016, also match plain 1016
      const stkMatch = search.trim().match(/^STK-?(\d+)$/i);
      if (stkMatch) {
        stickerSearchPatterns.push({ stickerNumber: stkMatch[1] });
      }
      query.$or = [
        ...stickerSearchPatterns,
        { customerName: searchRegex },
        { customerMobile: searchRegex },
        { companyName: searchRegex },
        { paymentMethod: searchRegex },
      ];
    }

    const totalElements = await Sale.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);

    const sales = await Sale.find(query)
      .sort({ createdAt: -1 })
      .skip(page * size)
      .limit(size);

    // Compute live summary aggregates across all matching records
    const allFiltered = await Sale.find(query).select('sellingPrice costPrice discountAmount grossProfit advanceAmount remainingBalance');
    let summarySelling = 0;
    let summaryDiscount = 0;
    let summaryProfit = 0;
    let summaryAdvance = 0;
    let summaryRemaining = 0;

    allFiltered.forEach((s) => {
      summarySelling += s.sellingPrice || 0;
      summaryDiscount += s.discountAmount || 0;
      summaryProfit += s.grossProfit || 0;
      summaryAdvance += s.advanceAmount || 0;
      summaryRemaining += s.remainingBalance || 0;
    });

    res.json({
      success: true,
      message: 'Sales retrieved successfully',
      data: {
        content: sales.map((s) => s.toJSON()),
        page,
        size,
        totalElements,
        totalPages,
        last: page >= totalPages - 1,
        summary: {
          totalCount: totalElements,
          totalSellingAmount: summarySelling,
          totalDiscounts: summaryDiscount,
          totalProfit: summaryProfit,
          totalAdvanceCollected: summaryAdvance,
          outstandingBalance: summaryRemaining,
        },
      },
    });
  } catch (error: any) {
    console.error('getAllSales error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getSaleById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale record not found', data: null });
      return;
    }
    if (req.user?.role === 'SALESPERSON' && sale.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied: You can only view your own orders', data: null });
      return;
    }
    res.json({ success: true, message: 'Sale record retrieved', data: sale.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getCustomerProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const identifier = String(req.params.identifier || '').trim();
    if (!identifier) {
      res.status(400).json({ success: false, message: 'Customer identifier is required', data: null });
      return;
    }

    const query: any = {};
    if (/^\d{10}$/.test(identifier.replace(/\D/g, ''))) {
      query.customerMobile = identifier.replace(/\D/g, '');
    } else {
      query.$or = [
        { customerMobile: identifier },
        { customerName: { $regex: new RegExp(`^${identifier.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') } },
      ];
    }

    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    }

    const orders = await Sale.find(query).sort({ createdAt: -1 });
    if (orders.length === 0) {
      res.status(404).json({ success: false, message: 'No orders found for this customer', data: null });
      return;
    }

    const customerName = orders[0].customerName;
    const customerMobile = orders[0].customerMobile;

    let totalPurchaseAmount = 0;
    let totalPaymentsReceived = 0;
    let outstandingBalance = 0;
    const allPayments: IPaymentTransaction[] = [];

    orders.forEach((o) => {
      totalPurchaseAmount += (o.sellingPrice || 0);
      totalPaymentsReceived += (o.advanceAmount || 0);
      outstandingBalance += (o.remainingBalance || 0);

      if (o.paymentTransactions && o.paymentTransactions.length > 0) {
        o.paymentTransactions.forEach((pt) => {
          allPayments.push({
            ...pt,
            notes: pt.notes ? `${o.stickerNumber}: ${pt.notes}` : `Order ${o.stickerNumber}`,
          });
        });
      }
    });

    res.json({
      success: true,
      message: 'Customer profile retrieved',
      data: {
        customerName,
        customerMobile,
        totalOrders: orders.length,
        totalPurchaseAmount,
        totalPaymentsReceived,
        outstandingBalance,
        orders: orders.map((o) => o.toJSON()),
        allPayments,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const createSale = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let {
      stickerNumber,
      companyName,
      productType = 'FRAME',
      costPrice,
      originalSellingPrice,
      discountType = 'NONE',
      discountValue = 0,
      advanceAmount = 0,
      paymentMethod = 'Cash',
      expectedDeliveryDate,
      deliveryStatus = 'PENDING',
      customerName,
      customerMobile,
      salespersonId: explicitSalespersonId,
    } = req.body;

    // Validate Customer Mobile Phone: exactly 10 digits
    const cleanMobile = String(customerMobile || '').trim().replace(/\D/g, '');
    if (!/^\d{10}$/.test(cleanMobile)) {
      res.status(400).json({
        success: false,
        message: 'Customer phone number must be exactly 10 digits without letters or special characters',
        data: null,
      });
      return;
    }

    if (!companyName || !expectedDeliveryDate || !customerName) {
      res.status(400).json({ success: false, message: 'Missing required order fields', data: null });
      return;
    }

    // Atomic Sequential Sticker Number Generation with STK- prefix
    let cleanSticker = stickerNumber ? String(stickerNumber).trim().toUpperCase() : '';
    if (!cleanSticker) {
      cleanSticker = await getNextAtomicStickerNumber();
    } else {
      // Ensure STK- prefix on manually provided sticker numbers
      if (/^\d+$/.test(cleanSticker)) {
        cleanSticker = `STK-${cleanSticker}`;
      } else if (!cleanSticker.startsWith('STK-')) {
        // Extract numeric part and re-prefix
        const numMatch = cleanSticker.match(/(\d+)/);
        if (numMatch) {
          cleanSticker = `STK-${numMatch[1]}`;
        }
      }
      // Check if provided sticker exists
      const existing = await Sale.findOne({ stickerNumber: cleanSticker });
      if (existing) {
        // If auto-generated collision or duplicate, atomically generate next number
        cleanSticker = await getNextAtomicStickerNumber();
      }
    }

    let salespersonId = req.user?.id || '';
    let salespersonName = req.user?.fullName || 'User';

    if (req.user?.role === 'ADMIN' && explicitSalespersonId) {
      const sp = await User.findById(explicitSalespersonId);
      if (sp) {
        salespersonId = sp._id.toString();
        salespersonName = sp.fullName;
      }
    }

    const numCost = Number(costPrice) || 0;
    const numOrigSelling = Number(originalSellingPrice) || 0;
    const numDiscVal = Number(discountValue) || 0;

    let discountAmount = 0;
    if (discountType === 'PERCENTAGE') {
      discountAmount = Math.round((numOrigSelling * numDiscVal) / 100);
    } else if (discountType === 'FIXED') {
      discountAmount = numDiscVal;
    }
    discountAmount = Math.max(0, Math.min(numOrigSelling, discountAmount));
    const sellingPrice = Math.max(0, numOrigSelling - discountAmount);

    const numAdvance = Number(advanceAmount) || 0;
    const remainingBalance = Math.max(0, sellingPrice - numAdvance);
    const grossProfit = sellingPrice - numCost;

    const todayStr = getIndianDateStr();
    const initialTransactions: IPaymentTransaction[] = [];
    if (numAdvance > 0) {
      initialTransactions.push({
        amount: numAdvance,
        paymentMethod: paymentMethod || 'Cash',
        date: todayStr,
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
        notes: 'Initial Advance Payment',
        receivedBy: req.user?.id,
        receivedByName: req.user?.fullName,
      });
    }

    const validProductType = ['FRAME', 'LENS'].includes(String(productType).toUpperCase())
      ? String(productType).toUpperCase()
      : 'FRAME';

    const validDeliveryStatus = String(deliveryStatus).toUpperCase() === 'DELIVERED' ? 'DELIVERED' : 'PENDING';
    const deliveredAt = validDeliveryStatus === 'DELIVERED' ? new Date() : undefined;
    const deliveredBy = validDeliveryStatus === 'DELIVERED' ? (req.user?.fullName || 'User') : undefined;

    let sale: ISale | null = null;
    let attempts = 0;

    while (attempts < 3) {
      try {
        sale = await Sale.create({
          stickerNumber: cleanSticker,
          companyName: String(companyName).trim(),
          productType: validProductType,
          costPrice: numCost,
          originalSellingPrice: numOrigSelling,
          discountType,
          discountValue: numDiscVal,
          discountAmount,
          sellingPrice,
          advanceAmount: numAdvance,
          remainingBalance,
          grossProfit,
          paymentMethod,
          paymentTransactions: initialTransactions,
          expectedDeliveryDate,
          deliveryStatus: validDeliveryStatus,
          deliveredAt,
          deliveredBy,
          customerName: String(customerName).trim(),
          customerMobile: cleanMobile,
          saleDate: todayStr,
          salespersonId,
          salespersonName,
        });
        break;
      } catch (err: any) {
        if (err.code === 11000) {
          // Concurrency conflict: get next atomic sticker and retry
          cleanSticker = await getNextAtomicStickerNumber();
          attempts++;
        } else {
          throw err;
        }
      }
    }

    if (!sale) {
      throw new Error('Failed to create order due to persistent sticker number conflict. Please try again.');
    }

    await AuditLog.create({
      action: 'CREATE_SALE',
      entityType: 'SALE',
      entityId: sale._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Created [${validProductType}] order ${sale.stickerNumber} for ${sale.customerName} (${sale.companyName}) - ₹${sale.sellingPrice}`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ success: true, message: 'Sale created successfully', data: sale.toJSON() });
  } catch (error: any) {
    console.error('createSale error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const updateSale = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale not found', data: null });
      return;
    }

    // Role-based authorization
    if (req.user?.role === 'SALESPERSON' && sale.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied: You can only edit your own orders', data: null });
      return;
    }

    const {
      companyName,
      productType,
      costPrice,
      originalSellingPrice,
      discountType,
      discountValue,
      paymentMethod,
      expectedDeliveryDate,
      deliveryStatus,
      customerName,
      customerMobile,
      salespersonId: explicitSalespersonId,
    } = req.body;

    // Validate phone number if provided
    if (customerMobile !== undefined) {
      const cleanMobile = String(customerMobile).trim().replace(/\D/g, '');
      if (!/^\d{10}$/.test(cleanMobile)) {
        res.status(400).json({
          success: false,
          message: 'Customer phone number must be exactly 10 digits without letters or special characters',
          data: null,
        });
        return;
      }
      sale.customerMobile = cleanMobile;
    }

    if (companyName) sale.companyName = String(companyName).trim();
    if (productType && ['FRAME', 'LENS', 'UNSPECIFIED'].includes(String(productType).toUpperCase())) {
      sale.productType = String(productType).toUpperCase() as any;
    }
    if (expectedDeliveryDate) sale.expectedDeliveryDate = expectedDeliveryDate;
    if (customerName) sale.customerName = String(customerName).trim();
    if (paymentMethod) sale.paymentMethod = paymentMethod;

    // Delivery Status update in Customer Editing
    if (deliveryStatus !== undefined) {
      const newStatus: DeliveryStatus = String(deliveryStatus).toUpperCase() === 'DELIVERED' ? 'DELIVERED' : 'PENDING';
      const prevStatus = sale.deliveryStatus;
      if (newStatus !== prevStatus) {
        sale.deliveryStatus = newStatus;
        if (newStatus === 'DELIVERED') {
          sale.deliveredAt = new Date();
          sale.deliveredBy = req.user?.fullName || 'User';
        } else {
          sale.deliveredAt = undefined;
          sale.deliveredBy = undefined;
        }

        await AuditLog.create({
          action: 'UPDATE_DELIVERY_STATUS',
          entityType: 'SALE',
          entityId: sale._id.toString(),
          performedBy: req.user?.id || 'system',
          performedByName: req.user?.fullName || 'User',
          details: `Delivery status changed from ${prevStatus} to ${newStatus} for ${sale.stickerNumber} (${sale.customerName})`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Reassignment to Sales Executive (Admin only)
    if (req.user?.role === 'ADMIN' && explicitSalespersonId && explicitSalespersonId !== sale.salespersonId) {
      const targetUser = await User.findById(explicitSalespersonId);
      if (targetUser) {
        const prevSalesperson = sale.salespersonName;
        sale.salespersonId = targetUser._id.toString();
        sale.salespersonName = targetUser.fullName;

        await AuditLog.create({
          action: 'REASSIGN_ORDER',
          entityType: 'SALE',
          entityId: sale._id.toString(),
          performedBy: req.user.id,
          performedByName: req.user.fullName,
          details: `Reassigned order ${sale.stickerNumber} from "${prevSalesperson}" to "${targetUser.fullName}" (@${targetUser.username})`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (originalSellingPrice !== undefined || costPrice !== undefined || discountValue !== undefined) {
      const numOrigSelling = originalSellingPrice !== undefined ? Number(originalSellingPrice) : sale.originalSellingPrice;
      const numCost = costPrice !== undefined ? Number(costPrice) : sale.costPrice;
      const dType = discountType !== undefined ? discountType : sale.discountType;
      const dVal = discountValue !== undefined ? Number(discountValue) : sale.discountValue;

      let discountAmount = 0;
      if (dType === 'PERCENTAGE') {
        discountAmount = Math.round((numOrigSelling * dVal) / 100);
      } else if (dType === 'FIXED') {
        discountAmount = dVal;
      }
      discountAmount = Math.max(0, Math.min(numOrigSelling, discountAmount));
      const sellingPrice = Math.max(0, numOrigSelling - discountAmount);

      sale.originalSellingPrice = numOrigSelling;
      sale.costPrice = numCost;
      sale.discountType = dType;
      sale.discountValue = dVal;
      sale.discountAmount = discountAmount;
      sale.sellingPrice = sellingPrice;
      sale.remainingBalance = Math.max(0, sellingPrice - sale.advanceAmount);
      sale.grossProfit = sellingPrice - numCost;
    }

    await sale.save();

    await AuditLog.create({
      action: 'UPDATE_SALE',
      entityType: 'SALE',
      entityId: sale._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Updated order ${sale.stickerNumber} (Delivery: ${sale.deliveryStatus}, Total: ₹${sale.sellingPrice})`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Sale updated successfully', data: sale.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const updateDeliveryStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale not found', data: null });
      return;
    }

    if (req.user?.role === 'SALESPERSON' && sale.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied: You can only update delivery status for your own orders', data: null });
      return;
    }

    const rawStatus = req.body.status || req.body.deliveryStatus;
    const newStatus: DeliveryStatus = String(rawStatus).toUpperCase() === 'DELIVERED' ? 'DELIVERED' : 'PENDING';
    const prevStatus = sale.deliveryStatus;

    sale.deliveryStatus = newStatus;
    if (newStatus === 'DELIVERED') {
      sale.deliveredAt = new Date();
      sale.deliveredBy = req.user?.fullName || 'User';
    } else {
      sale.deliveredAt = undefined;
      sale.deliveredBy = undefined;
    }

    await sale.save();

    await AuditLog.create({
      action: 'UPDATE_DELIVERY_STATUS',
      entityType: 'SALE',
      entityId: sale._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Delivery status changed from ${prevStatus} to ${newStatus} for ${sale.stickerNumber} by ${req.user?.fullName}`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Delivery status updated to ${newStatus}`,
      data: sale.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const clearBalance = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale not found', data: null });
      return;
    }

    if (req.user?.role === 'SALESPERSON' && sale.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied: You can only clear balance on your own orders', data: null });
      return;
    }

    const { paymentMethod = 'Cash', notes = 'Customer Balance Cleared' } = req.body;
    const remainingToClear = sale.remainingBalance;

    if (remainingToClear > 0) {
      const todayStr = getIndianDateStr();
      const validMethod = String(paymentMethod).trim() || 'Cash';

      sale.paymentTransactions.push({
        amount: remainingToClear,
        paymentMethod: validMethod,
        date: todayStr,
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
        notes: String(notes).trim() || 'Customer Balance Cleared (Full Payment)',
        receivedBy: req.user?.id,
        receivedByName: req.user?.fullName,
      });

      sale.advanceAmount += remainingToClear;
      sale.remainingBalance = 0;
      sale.paymentMethod = validMethod;
      await sale.save();

      await AuditLog.create({
        action: 'CLEAR_BALANCE',
        entityType: 'SALE',
        entityId: sale._id.toString(),
        performedBy: req.user?.id || 'system',
        performedByName: req.user?.fullName || 'User',
        details: `Cleared balance of ₹${remainingToClear} via ${validMethod} for ${sale.stickerNumber} (${sale.customerName})`,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: `Customer balance of ₹${remainingToClear} has been cleared and payment transaction recorded.`,
      data: sale.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const addPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale not found', data: null });
      return;
    }

    if (req.user?.role === 'SALESPERSON' && sale.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied to this sale', data: null });
      return;
    }

    const { amount, paymentMethod = 'Cash', notes = '' } = req.body;
    const payAmount = Number(amount);
    if (!payAmount || payAmount <= 0) {
      res.status(400).json({ success: false, message: 'Payment amount must be greater than zero', data: null });
      return;
    }

    const todayStr = getIndianDateStr();
    const validMethod = String(paymentMethod).trim() || 'Cash';

    sale.paymentTransactions.push({
      amount: payAmount,
      paymentMethod: validMethod,
      date: todayStr,
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      notes: String(notes).trim() || 'Additional customer payment',
      receivedBy: req.user?.id,
      receivedByName: req.user?.fullName,
    });

    const totalCollected = sale.paymentTransactions.reduce((acc, t) => acc + (t.amount || 0), 0);
    sale.advanceAmount = totalCollected;
    sale.remainingBalance = Math.max(0, sale.sellingPrice - totalCollected);
    sale.paymentMethod = validMethod;

    await sale.save();

    await AuditLog.create({
      action: 'ADD_PAYMENT',
      entityType: 'SALE',
      entityId: sale._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Added payment of ₹${payAmount} via ${validMethod} for ${sale.stickerNumber}`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Payment recorded successfully', data: sale.toJSON() });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getDailyStatement = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const selectedDate = req.query.date ? String(req.query.date).trim() : getIndianDateStr();
    const query: any = { saleDate: selectedDate };

    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    }

    const orders = await Sale.find(query).sort({ createdAt: 1 });

    let totalSellingAmount = 0;
    let totalCostAmount = 0;
    let totalDiscountGiven = 0;
    let totalAdvanceCollected = 0;
    let remainingBalance = 0;
    let pendingDeliveries = 0;
    let deliveredOrders = 0;

    for (const o of orders) {
      totalSellingAmount += o.sellingPrice;
      totalCostAmount += o.costPrice;
      totalDiscountGiven += (o.discountAmount || 0);
      totalAdvanceCollected += o.advanceAmount;
      remainingBalance += o.remainingBalance;
      if (o.deliveryStatus === 'DELIVERED') deliveredOrders++;
      else pendingDeliveries++;
    }

    const totalProfit = totalSellingAmount - totalCostAmount;

    // Accurate calculation of today's actual collections across all payment transactions
    const paymentMethodTotals: Record<string, number> = {};
    let totalCollection = 0;

    // Scan all sales in scope for payments received on selectedDate
    const scopeQuery: any = {};
    if (req.user?.role === 'SALESPERSON') {
      scopeQuery.salespersonId = req.user.id;
    }
    const allSalesForPayments = await Sale.find(scopeQuery).select('paymentTransactions');
    allSalesForPayments.forEach((s) => {
      if (s.paymentTransactions) {
        s.paymentTransactions.forEach((tx) => {
          if (tx.date === selectedDate) {
            const amt = tx.amount || 0;
            totalCollection += amt;
            const method = tx.paymentMethod || 'Cash';
            paymentMethodTotals[method] = (paymentMethodTotals[method] || 0) + amt;
          }
        });
      }
    });

    res.json({
      success: true,
      message: 'Daily statement retrieved',
      data: {
        date: selectedDate,
        totalOrders: orders.length,
        totalSellingAmount,
        totalCostAmount,
        totalDiscountGiven,
        totalProfit,
        totalAdvanceCollected,
        totalCollection,
        paymentMethodTotals,
        remainingBalance,
        pendingDeliveries,
        deliveredOrders,
        orders: orders.map((o) => o.toJSON()),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getOverdueSales = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const todayStr = getIndianDateStr();
    const query: any = {
      deliveryStatus: 'PENDING',
      expectedDeliveryDate: { $lt: todayStr },
    };

    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    }

    const overdue = await Sale.find(query).sort({ expectedDeliveryDate: 1 });
    res.json({
      success: true,
      message: 'Overdue sales retrieved',
      data: overdue.map((s) => s.toJSON()),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getDashboardStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';
    const filterSalesperson = req.query.salespersonId ? String(req.query.salespersonId).trim() : '';

    const query: any = {};
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    } else if (filterSalesperson) {
      query.salespersonId = filterSalesperson;
    }

    if (dateFrom && dateTo) {
      query.saleDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.saleDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.saleDate = { $lte: dateTo };
    }

    const sales = await Sale.find(query);

    let totalRevenue = 0;
    let totalCost = 0;
    let grossProfit = 0;
    let totalDiscounts = 0;
    let advanceCollected = 0;
    let remainingBalance = 0;
    let deliveredOrders = 0;
    let pendingOrders = 0;

    // Frame Analytics
    let frameOrders = 0;
    let frameRevenue = 0;
    let frameCost = 0;
    let frameProfit = 0;
    let frameDiscount = 0;
    const frameBrandMap = new Map<string, number>();

    // Lens Analytics
    let lensOrders = 0;
    let lensRevenue = 0;
    let lensCost = 0;
    let lensProfit = 0;
    let lensDiscount = 0;
    const lensBrandMap = new Map<string, number>();

    const dailyMap = new Map<string, { date: string; revenue: number; orders: number; profit: number; collection: number }>();
    const brandMap = new Map<string, { company: string; brand: string; count: number; orders: number; revenue: number; profit: number }>();

    for (const s of sales) {
      totalRevenue += s.sellingPrice;
      totalCost += s.costPrice;
      grossProfit += s.grossProfit;
      totalDiscounts += (s.discountAmount || 0);
      advanceCollected += s.advanceAmount;
      remainingBalance += s.remainingBalance;

      if (s.deliveryStatus === 'DELIVERED') deliveredOrders++;
      else pendingOrders++;

      const pType = (s.productType || 'UNSPECIFIED').toUpperCase();
      if (pType === 'FRAME') {
        frameOrders++;
        frameRevenue += s.sellingPrice;
        frameCost += s.costPrice;
        frameProfit += s.grossProfit;
        frameDiscount += (s.discountAmount || 0);
        frameBrandMap.set(s.companyName, (frameBrandMap.get(s.companyName) || 0) + 1);
      } else if (pType === 'LENS') {
        lensOrders++;
        lensRevenue += s.sellingPrice;
        lensCost += s.costPrice;
        lensProfit += s.grossProfit;
        lensDiscount += (s.discountAmount || 0);
        lensBrandMap.set(s.companyName, (lensBrandMap.get(s.companyName) || 0) + 1);
      }

      // Daily trend
      const d = s.saleDate;
      const curDaily = dailyMap.get(d) || { date: d, revenue: 0, orders: 0, profit: 0, collection: 0 };
      curDaily.revenue += s.sellingPrice;
      curDaily.orders += 1;
      curDaily.profit += s.grossProfit;
      curDaily.collection += (s.advanceAmount || 0);
      dailyMap.set(d, curDaily);

      // Brand
      const b = s.companyName || 'Unknown';
      const curBrand = brandMap.get(b) || { company: b, brand: b, count: 0, orders: 0, revenue: 0, profit: 0 };
      curBrand.count += 1;
      curBrand.orders += 1;
      curBrand.revenue += s.sellingPrice;
      curBrand.profit += s.grossProfit;
      brandMap.set(b, curBrand);
    }

    const topFrameBrands = Array.from(frameBrandMap.entries())
      .map(([brand, count]) => ({ brand, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const topLensBrands = Array.from(lensBrandMap.entries())
      .map(([brand, count]) => ({ brand, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const dailySales = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const dailyTrends = dailySales;
    const companySales = Array.from(brandMap.values()).sort((a, b) => b.revenue - a.revenue);
    const brandDistribution = companySales;

    // Today's Pulse Metrics in local Indian Standard Time
    const todayStr = getIndianDateStr();
    const todayScopeQuery: any = {};
    if (req.user?.role === 'SALESPERSON') {
      todayScopeQuery.salespersonId = req.user.id;
    } else if (filterSalesperson) {
      todayScopeQuery.salespersonId = filterSalesperson;
    }

    const allScopeSales = await Sale.find(todayScopeQuery).select('paymentTransactions saleDate sellingPrice discountAmount grossProfit');
    let todayCollection = 0;
    let todayOrders = 0;
    let todayRevenue = 0;
    let todayDiscount = 0;
    let todayProfit = 0;

    for (const s of allScopeSales) {
      if (s.paymentTransactions) {
        for (const tx of s.paymentTransactions) {
          if (tx.date === todayStr) {
            todayCollection += (tx.amount || 0);
          }
        }
      }
      if (s.saleDate === todayStr) {
        todayOrders++;
        todayRevenue += (s.sellingPrice || 0);
        todayDiscount += (s.discountAmount || 0);
        todayProfit += (s.grossProfit || 0);
      }
    }

    // Customer Feedback Summary
    const feedbacks = await CustomerFeedback.find().lean();
    let averageCustomerRating = 0;
    const totalCustomerFeedback = feedbacks.length;
    if (totalCustomerFeedback > 0) {
      const sum = feedbacks.reduce((acc, f) => acc + (f.rating || 0), 0);
      averageCustomerRating = Number((sum / totalCustomerFeedback).toFixed(1));
    }

    // Payment Method Distribution (actual payment transactions across matching sales)
    const payMethodMap = new Map<string, { method: string; total: number; count: number }>();
    ['Cash', 'UPI', 'Debit Card', 'Credit Card'].forEach((m) => {
      payMethodMap.set(m, { method: m, total: 0, count: 0 });
    });

    for (const s of sales) {
      if (s.paymentTransactions && s.paymentTransactions.length > 0) {
        for (const tx of s.paymentTransactions) {
          const rawMethod = String(tx.paymentMethod || 'Cash').trim();
          let m = rawMethod;
          if (['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'UPI', 'GPay'].includes(rawMethod)) {
            m = 'UPI';
          }
          const cur = payMethodMap.get(m) || { method: m, total: 0, count: 0 };
          cur.total += (tx.amount || 0);
          cur.count += 1;
          payMethodMap.set(m, cur);
        }
      } else if (s.advanceAmount > 0) {
        const rawMethod = String(s.paymentMethod || 'Cash').trim();
        let m = rawMethod;
        if (['Google Pay', 'PhonePe', 'Paytm', 'BHIM', 'UPI', 'GPay'].includes(rawMethod)) {
          m = 'UPI';
        }
        const cur = payMethodMap.get(m) || { method: m, total: 0, count: 0 };
        cur.total += s.advanceAmount;
        cur.count += 1;
        payMethodMap.set(m, cur);
      }
    }
    const paymentMethodDistribution = Array.from(payMethodMap.values()).filter(
      (p) => p.count > 0 || ['Cash', 'UPI', 'Debit Card', 'Credit Card'].includes(p.method)
    );

    // Sales Specialist Leaderboard (Dynamic across all active Sales Executives)
    const activeSalespersons = await User.find({ role: 'SALESPERSON', active: true }).sort({ fullName: 1 }).lean();
    const salespersonPerformance = await Promise.all(
      activeSalespersons.map(async (sp) => {
        const spQuery: any = { salespersonId: sp._id.toString() };
        if (dateFrom && dateTo) spQuery.saleDate = { $gte: dateFrom, $lte: dateTo };
        else if (dateFrom) spQuery.saleDate = { $gte: dateFrom };
        else if (dateTo) spQuery.saleDate = { $lte: dateTo };

        const spSales = await Sale.find(spQuery).select('sellingPrice costPrice advanceAmount remainingBalance grossProfit');
        let spOrders = spSales.length;
        let spSalesTotal = 0;
        let spCostTotal = 0;
        let spAdvanceTotal = 0;
        let spRemainingTotal = 0;
        let spProfitTotal = 0;

        for (const o of spSales) {
          spSalesTotal += (o.sellingPrice || 0);
          spCostTotal += (o.costPrice || 0);
          spAdvanceTotal += (o.advanceAmount || 0);
          spRemainingTotal += (o.remainingBalance || 0);
          spProfitTotal += (o.grossProfit !== undefined ? o.grossProfit : (o.sellingPrice - o.costPrice));
        }

        return {
          id: sp._id.toString(),
          name: sp.fullName,
          username: sp.username,
          orders: spOrders,
          sales: spSalesTotal,
          revenue: spSalesTotal,
          collection: spAdvanceTotal,
          profit: spProfitTotal,
          pendingBalance: spRemainingTotal,
        };
      })
    );
    salespersonPerformance.sort((a, b) => b.sales - a.sales);

    const deliverySuccessRate = sales.length > 0 ? Math.round((deliveredOrders / sales.length) * 100) : 0;
    const deliveryStatusData = [
      { status: 'Delivered', count: deliveredOrders },
      { status: 'Lab Pending', count: pendingOrders },
    ];

    res.json({
      success: true,
      message: 'Dashboard statistics retrieved',
      data: {
        totalOrders: sales.length,
        totalRevenue,
        netSales: totalRevenue,
        totalCost,
        grossProfit,
        totalDiscounts,
        advanceCollected,
        remainingBalance,
        deliveredOrders,
        pendingOrders,
        deliverySuccessRate,
        deliveryFulfilmentRate: deliverySuccessRate,
        deliveryStatusData,
        todayCollection,
        todayOrders,
        todayRevenue,
        todayDiscount,
        todayProfit,
        averageCustomerRating,
        totalCustomerFeedback,
        dailySales,
        dailyTrends,
        companySales,
        brandDistribution,
        paymentMethodDistribution,
        salespersonPerformance,
        frameAnalytics: {
          totalOrders: frameOrders,
          revenue: frameRevenue,
          cost: frameCost,
          profit: frameProfit,
          discount: frameDiscount,
          topBrands: topFrameBrands,
        },
        lensAnalytics: {
          totalOrders: lensOrders,
          revenue: lensRevenue,
          cost: lensCost,
          profit: lensProfit,
          discount: lensDiscount,
          topBrands: topLensBrands,
        },
      },
    });
  } catch (error: any) {
    console.error('getDashboardStats error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const deleteSale = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      res.status(404).json({ success: false, message: 'Sale not found', data: null });
      return;
    }

    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ success: false, message: 'Access denied: Only administrators can delete orders', data: null });
      return;
    }

    await Sale.findByIdAndDelete(req.params.id);

    await AuditLog.create({
      action: 'DELETE_SALE',
      entityType: 'SALE',
      entityId: sale._id.toString(),
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: `Deleted sale ${sale.stickerNumber} (${sale.customerName})`,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, message: 'Sale deleted successfully', data: null });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};
