import { Response } from 'express';
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { AuthRequest } from '../types';
import { Supplier, ISupplier } from '../models/Supplier';
import { SupplierInvoice, ISupplierInvoice } from '../models/SupplierInvoice';
import { SupplierDocument } from '../models/SupplierDocument';
import { Product } from '../models/Product';
import { InventoryLog } from '../models/InventoryLog';
import { Counter } from '../models/Counter';
import { AuditLog } from '../models/AuditLog';
import { getIndianDateStr } from './salesController';
import {
  buildSupplierPdfBlobPathname,
  uploadPrivatePdfBlob,
  getPrivatePdfBlob,
  deletePrivatePdfBlob,
  MAX_PDF_FILE_SIZE_BYTES,
} from '../utils/blobStorage';

const getIndianTimeStr = (): string => {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

const getNextSupplierReceiptNumber = async (): Promise<string> => {
  const counter = await Counter.findByIdAndUpdate(
    'supplierReceiptNumber',
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  const seq = counter?.seq || 1001;
  return `SRI-SUP-${seq}`;
};

// GET /api/suppliers
export const getSuppliers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const suppliers = await Supplier.find({ active: true }).sort({ supplierName: 1 });
    
    // Enrich with aggregated stats
    const enriched = await Promise.all(
      suppliers.map(async (sup) => {
        const invoices = await SupplierInvoice.find({ supplierName: sup.supplierName });
        const totalInvoices = invoices.length;
        const totalPurchaseAmount = invoices.reduce((sum, inv) => sum + (inv.netPrice || 0), 0);
        const totalPaid = invoices.reduce((sum, inv) => sum + (inv.totalPaid || 0), 0);
        const outstandingBalance = Math.max(0, totalPurchaseAmount - totalPaid);

        return {
          ...sup.toJSON(),
          totalInvoices,
          totalPurchaseAmount,
          totalPaid,
          outstandingBalance,
        };
      })
    );

    res.json({
      success: true,
      message: 'Suppliers retrieved',
      data: enriched,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// POST /api/suppliers
export const createSupplier = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { supplierName, contactPerson, mobileNumber, email, address } = req.body;
    if (!supplierName || !String(supplierName).trim()) {
      res.status(400).json({ success: false, message: 'Supplier Name is required', data: null });
      return;
    }

    const cleanName = String(supplierName).trim();
    const existing = await Supplier.findOne({
      supplierName: new RegExp(`^${cleanName}$`, 'i'),
    });
    if (existing) {
      res.status(400).json({
        success: false,
        message: `Supplier "${cleanName}" already exists`,
        data: null,
      });
      return;
    }

    const supplier = await Supplier.create({
      supplierName: cleanName,
      contactPerson: String(contactPerson || '').trim(),
      mobileNumber: String(mobileNumber || '').trim(),
      email: String(email || '').trim().toLowerCase(),
      address: String(address || '').trim(),
    });

    await AuditLog.create({
      action: 'CREATE_SUPPLIER',
      entityType: 'SUPPLIER',
      entityId: supplier._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Registered new supplier "${supplier.supplierName}"`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: 'Supplier registered successfully',
      data: supplier.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/:id (or by supplierName)
export const getSupplierProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let supplier: ISupplier | null = null;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      supplier = await Supplier.findById(req.params.id);
    }
    if (!supplier) {
      supplier = await Supplier.findOne({
        supplierName: new RegExp(`^${decodeURIComponent(req.params.id).trim()}$`, 'i'),
      });
    }

    const supplierName = supplier ? supplier.supplierName : decodeURIComponent(req.params.id).trim();

    // Fetch all invoices for this supplier
    const invoices = await SupplierInvoice.find({
      supplierName: new RegExp(`^${supplierName}$`, 'i'),
    }).sort({ invoiceDate: -1, createdAt: -1 });

    const totalInvoices = invoices.length;
    const totalPurchaseAmount = invoices.reduce((sum, inv) => sum + (inv.netPrice || 0), 0);
    const totalPaid = invoices.reduce((sum, inv) => sum + (inv.totalPaid || 0), 0);
    const outstandingBalance = Math.max(0, totalPurchaseAmount - totalPaid);

    // Flatten all chronological payment transactions across invoices
    const allPayments: any[] = [];
    invoices.forEach((inv) => {
      if (inv.paymentHistory && inv.paymentHistory.length > 0) {
        inv.paymentHistory.forEach((p) => {
          allPayments.push({
            receiptNumber: p.receiptNumber,
            invoiceId: inv._id.toString(),
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: inv.invoiceDate,
            amount: p.amount,
            date: p.date,
            time: p.time,
            paymentMethod: p.paymentMethod,
            referenceNumber: p.referenceNumber,
            remainingBalance: p.remainingBalance,
            notes: p.notes,
            paymentStatus: inv.paymentStatus,
          });
        });
      }
    });

    // Sort payments chronologically descending
    allPayments.sort((a, b) => (b.date + ' ' + (b.time || '')).localeCompare(a.date + ' ' + (a.time || '')));

    res.json({
      success: true,
      message: 'Supplier profile retrieved',
      data: {
        supplier: supplier
          ? supplier.toJSON()
          : { supplierName, contactPerson: '', mobileNumber: '', email: '', address: '' },
        totalInvoices,
        totalPurchaseAmount,
        totalPaid,
        outstandingBalance,
        invoices: invoices.map((inv) => inv.toJSON()),
        paymentHistory: allPayments,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/invoices
export const getSupplierInvoices = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '20'), 10)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const supplierName = req.query.supplierName ? String(req.query.supplierName).trim() : '';
    const brandName = req.query.brandName ? String(req.query.brandName).trim() : '';
    const invoiceNumber = req.query.invoiceNumber ? String(req.query.invoiceNumber).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus).trim().toUpperCase() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};

    if (search) {
      const reg = new RegExp(search.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      query.$or = [
        { supplierName: reg },
        { invoiceNumber: reg },
        { 'products.brandName': reg },
        { 'products.brandUniqueNumber': reg },
      ];
    }

    if (supplierName) {
      query.supplierName = new RegExp(`^${supplierName}$`, 'i');
    }

    if (brandName) {
      query['products.brandName'] = new RegExp(`^${brandName}$`, 'i');
    }

    if (invoiceNumber) {
      query.invoiceNumber = new RegExp(invoiceNumber, 'i');
    }

    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query['products.productType'] = productType;
    }

    if (paymentStatus && ['CLEARED', 'PARTIAL', 'PENDING'].includes(paymentStatus)) {
      query.paymentStatus = paymentStatus;
    }

    if (dateFrom && dateTo) {
      query.invoiceDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.invoiceDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.invoiceDate = { $lte: dateTo };
    }

    const totalElements = await SupplierInvoice.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);
    const invoices = await SupplierInvoice.find(query)
      .sort({ invoiceDate: -1, createdAt: -1 })
      .skip(page * size)
      .limit(size);

    res.json({
      success: true,
      message: 'Supplier invoices retrieved',
      data: {
        content: invoices.map((inv) => inv.toJSON()),
        page,
        size,
        totalElements,
        totalPages,
        last: page >= totalPages - 1,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// POST /api/suppliers/invoices
export const createSupplierInvoice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      supplierName,
      contactPerson = '',
      mobileNumber = '',
      invoiceNumber,
      invoiceDate = getIndianDateStr(),
      invoiceTime = getIndianTimeStr(),
      products = [],
      netPrice,
      advanceAmount = 0,
      paymentType = 'Cash',
      notes = '',
    } = req.body;

    if (!supplierName || !invoiceNumber || netPrice === undefined) {
      res.status(400).json({
        success: false,
        message: 'Supplier Name, Invoice Number, and Net Price are mandatory',
        data: null,
      });
      return;
    }

    const cleanInvoiceNum = String(invoiceNumber).trim().toUpperCase();
    const cleanSupplierName = String(supplierName).trim();

    // Check duplicate invoice number for the same supplier
    const existing = await SupplierInvoice.findOne({
      supplierName: new RegExp(`^${cleanSupplierName}$`, 'i'),
      invoiceNumber: cleanInvoiceNum,
    });
    if (existing) {
      res.status(400).json({
        success: false,
        message: `Invoice #${cleanInvoiceNum} already exists for supplier "${cleanSupplierName}"`,
        data: null,
      });
      return;
    }

    // Ensure Supplier exists or create automatically with Contact Info (Requirement 8)
    let supplierDoc = await Supplier.findOne({
      supplierName: new RegExp(`^${cleanSupplierName}$`, 'i'),
    });
    if (!supplierDoc) {
      supplierDoc = await Supplier.create({
        supplierName: cleanSupplierName,
        contactPerson: String(contactPerson || '').trim(),
        mobileNumber: String(mobileNumber || '').trim(),
      });
    } else {
      let updated = false;
      if (contactPerson && String(contactPerson).trim() && supplierDoc.contactPerson !== String(contactPerson).trim()) {
        supplierDoc.contactPerson = String(contactPerson).trim();
        updated = true;
      }
      if (mobileNumber && String(mobileNumber).trim() && supplierDoc.mobileNumber !== String(mobileNumber).trim()) {
        supplierDoc.mobileNumber = String(mobileNumber).trim();
        updated = true;
      }
      if (updated) {
        await supplierDoc.save();
      }
    }

    const numNetPrice = Math.max(0, parseFloat(String(netPrice || 0)));
    const numAdvance = Math.max(0, parseFloat(String(advanceAmount || 0)));
    const totalPaid = Math.min(numNetPrice, numAdvance);
    const balanceAmount = Math.max(0, numNetPrice - totalPaid);

    // Normalize products list (Unit Cost removed from UI, safe fallback calculation)
    let totalQty = 0;
    let totalFrames = 0;
    let totalLenses = 0;

    const rawList = Array.isArray(products) ? products : [];
    const sumQty = rawList.reduce((acc: number, p: any) => acc + Math.max(1, parseInt(String(p.quantity || 1), 10)), 0);

    const normalizedProducts = rawList.map((p: any) => {
      const type = String(p.productType || 'FRAME').toUpperCase() === 'LENS' ? 'LENS' : 'FRAME';
      const qty = Math.max(1, parseInt(String(p.quantity || 1), 10));
      const fQty = type === 'FRAME' ? qty : 0;
      const lQty = type === 'LENS' ? qty : 0;
      
      let uCost = parseFloat(String(p.price !== undefined && p.price !== '' ? p.price : (p.unitCost || 0))) || 0;
      if (uCost === 0 && numNetPrice > 0 && sumQty > 0) {
        uCost = Math.round((numNetPrice / sumQty) * 100) / 100;
      }
      const tCost = parseFloat(String(p.totalCost || (uCost * qty))) || (uCost * qty);

      totalQty += qty;
      totalFrames += fQty;
      totalLenses += lQty;

      return {
        brandName: String(p.brandName || '').trim(),
        brandUniqueNumber: String(p.brandUniqueNumber || '').trim().toUpperCase(),
        productType: type,
        productIdentification: String(p.productIdentification || '').trim(),
        quantity: qty,
        frameQuantity: fQty,
        lensQuantity: lQty,
        unitCost: uCost,
        totalCost: tCost,
      };
    });

    let paymentStatus: 'CLEARED' | 'PARTIAL' | 'PENDING' = 'PENDING';
    if (balanceAmount === 0 && numNetPrice > 0) {
      paymentStatus = 'CLEARED';
    } else if (totalPaid > 0) {
      paymentStatus = 'PARTIAL';
    }

    // Initial payment record if advance > 0
    const paymentHistory: any[] = [];
    if (totalPaid > 0) {
      const receiptNo = await getNextSupplierReceiptNumber();
      paymentHistory.push({
        receiptNumber: receiptNo,
        amount: totalPaid,
        date: invoiceDate,
        time: invoiceTime,
        paymentMethod: paymentType,
        referenceNumber: req.body.referenceNumber || '',
        remainingBalance: balanceAmount,
        recordedBy: req.user?.id || 'admin',
        recordedByName: req.user?.fullName || 'Admin',
        notes: 'Initial Supplier Advance Payment',
      });
    }

    const invoice = await SupplierInvoice.create({
      invoiceNumber: cleanInvoiceNum,
      supplierId: supplierDoc._id,
      supplierName: cleanSupplierName,
      contactPerson: supplierDoc.contactPerson || String(contactPerson || '').trim(),
      mobileNumber: supplierDoc.mobileNumber || String(mobileNumber || '').trim(),
      invoiceDate,
      invoiceTime,
      products: normalizedProducts,
      totalQuantity: totalQty,
      frameQuantity: totalFrames,
      lensQuantity: totalLenses,
      netPrice: numNetPrice,
      advanceAmount: numAdvance,
      totalPaid,
      balanceAmount,
      paymentType,
      paymentStatus,
      clearedAt: paymentStatus === 'CLEARED' ? new Date() : undefined,
      clearedBy: paymentStatus === 'CLEARED' ? (req.user?.fullName || 'Admin') : undefined,
      paymentHistory,
      notes: String(notes || '').trim(),
    });

    // AUTOMATIC STOCK RECEPTION INVENTORY LEDGER UPDATE
    // For each product received, update inventory and log SUPPLIER_RECEIVED
    for (const item of normalizedProducts) {
      if (!item.brandUniqueNumber) continue;

      let product = await Product.findOne({ brandUniqueNumber: item.brandUniqueNumber });
      if (!product) {
        // Auto-create product in Master Catalog if it doesn't exist
        product = await Product.create({
          brandName: item.brandName || 'Optical',
          productType: item.productType,
          brandUniqueNumber: item.brandUniqueNumber,
          productIdentification: item.productIdentification || `${item.brandName} (${item.productType})`,
          price: item.unitCost * 1.5, // default markup
          costPrice: item.unitCost,
          quantity: item.quantity,
          frameQuantity: item.productType === 'FRAME' ? item.quantity : 0,
          lensQuantity: item.productType === 'LENS' ? item.quantity : 0,
          createdBy: req.user?.username || 'ADMIN',
        });

        await InventoryLog.create({
          productUniqueNumber: item.brandUniqueNumber,
          productId: product._id,
          brandName: item.brandName,
          productType: item.productType,
          movementType: 'SUPPLIER_RECEIVED',
          quantity: item.quantity,
          previousStock: 0,
          newStock: item.quantity,
          referenceInvoiceNumber: cleanInvoiceNum,
          performedBy: req.user?.id || 'admin',
          performedByName: req.user?.fullName || 'Admin',
          notes: `Received from supplier "${cleanSupplierName}" (Invoice #${cleanInvoiceNum})`,
          date: invoiceDate,
          time: invoiceTime,
        });
      } else {
        const prevStock = product.quantity;
        const newStock = prevStock + item.quantity;
        product.quantity = newStock;
        product.frameQuantity = product.productType === 'FRAME' ? newStock : 0;
        product.lensQuantity = product.productType === 'LENS' ? newStock : 0;
        if (item.unitCost > 0) product.costPrice = item.unitCost;
        await product.save();

        await InventoryLog.create({
          productUniqueNumber: item.brandUniqueNumber,
          productId: product._id,
          brandName: product.brandName,
          productType: product.productType,
          movementType: 'SUPPLIER_RECEIVED',
          quantity: item.quantity,
          previousStock: prevStock,
          newStock: newStock,
          referenceInvoiceNumber: cleanInvoiceNum,
          performedBy: req.user?.id || 'admin',
          performedByName: req.user?.fullName || 'Admin',
          notes: `Stock received from supplier "${cleanSupplierName}" (Invoice #${cleanInvoiceNum})`,
          date: invoiceDate,
          time: invoiceTime,
        });
      }
    }

    await AuditLog.create({
      action: 'CREATE_SUPPLIER_INVOICE',
      entityType: 'SUPPLIER_INVOICE',
      entityId: invoice._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Created supplier invoice #${cleanInvoiceNum} from "${cleanSupplierName}" (Net: ₹${numNetPrice}, Paid: ₹${totalPaid}, Balance: ₹${balanceAmount})`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: 'Supplier invoice recorded successfully with stock intake',
      data: invoice.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// POST /api/suppliers/invoices/:id/payments
export const recordSupplierPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoice = await SupplierInvoice.findById(req.params.id);
    if (!invoice) {
      res.status(404).json({ success: false, message: 'Supplier invoice not found', data: null });
      return;
    }

    const {
      amount,
      paymentMethod = 'Cash',
      referenceNumber = '',
      notes = '',
      date = getIndianDateStr(),
      time = getIndianTimeStr(),
    } = req.body;

    const numAmount = parseFloat(String(amount || 0));
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ success: false, message: 'Valid payment amount > 0 is required', data: null });
      return;
    }

    if (numAmount > invoice.balanceAmount) {
      res.status(400).json({
        success: false,
        message: `Payment amount (₹${numAmount}) exceeds outstanding balance (₹${invoice.balanceAmount})`,
        data: null,
      });
      return;
    }

    const receiptNo = await getNextSupplierReceiptNumber();
    const newTotalPaid = (invoice.totalPaid || 0) + numAmount;
    const newBalance = Math.max(0, invoice.netPrice - newTotalPaid);

    invoice.totalPaid = newTotalPaid;
    invoice.balanceAmount = newBalance;
    invoice.paymentStatus = newBalance === 0 ? 'CLEARED' : 'PARTIAL';
    if (newBalance === 0) {
      invoice.clearedAt = new Date();
      invoice.clearedBy = req.user?.fullName || 'Admin';
    }

    const paymentRecord = {
      receiptNumber: receiptNo,
      amount: numAmount,
      date,
      time,
      paymentMethod,
      referenceNumber: String(referenceNumber || '').trim(),
      remainingBalance: newBalance,
      recordedBy: req.user?.id || 'admin',
      recordedByName: req.user?.fullName || 'Admin',
      notes: String(notes || 'Supplier Payment').trim(),
    };

    invoice.paymentHistory.push(paymentRecord as any);
    await invoice.save();

    await AuditLog.create({
      action: 'SUPPLIER_PAYMENT',
      entityType: 'SUPPLIER_INVOICE',
      entityId: invoice._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Recorded payment of ₹${numAmount} for invoice #${invoice.invoiceNumber} to "${invoice.supplierName}" (Receipt: ${receiptNo}, Balance: ₹${newBalance})`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Payment of ₹${numAmount} recorded successfully! Receipt: ${receiptNo}`,
      data: {
        invoice: invoice.toJSON(),
        paymentRecord,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// PATCH /api/suppliers/invoices/:id/mark-clear
// Requirements C.4: Mark as Clear button
export const markSupplierInvoiceCleared = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoice = await SupplierInvoice.findById(req.params.id);
    if (!invoice) {
      res.status(404).json({ success: false, message: 'Supplier invoice not found', data: null });
      return;
    }

    const outstanding = invoice.balanceAmount || 0;
    if (outstanding <= 0) {
      res.status(400).json({
        success: false,
        message: 'This supplier invoice is already fully cleared with ₹0 balance',
        data: null,
      });
      return;
    }

    const receiptNo = await getNextSupplierReceiptNumber();
    const today = getIndianDateStr();
    const timeNow = getIndianTimeStr();
    const paymentMethod = req.body.paymentMethod || invoice.paymentType || 'Cash';

    // Record the actual clearance payment transaction
    const clearancePayment = {
      receiptNumber: receiptNo,
      amount: outstanding,
      date: today,
      time: timeNow,
      paymentMethod,
      referenceNumber: req.body.referenceNumber || 'FULL-CLEARANCE',
      remainingBalance: 0,
      recordedBy: req.user?.id || 'admin',
      recordedByName: req.user?.fullName || 'Admin',
      notes: req.body.notes || 'Full clearance payment via Mark as Clear',
    };

    invoice.totalPaid = invoice.netPrice;
    invoice.balanceAmount = 0;
    invoice.paymentStatus = 'CLEARED';
    invoice.clearedAt = new Date();
    invoice.clearedBy = req.user?.fullName || 'Admin';
    invoice.paymentHistory.push(clearancePayment as any);

    await invoice.save();

    await AuditLog.create({
      action: 'CLEAR_SUPPLIER_INVOICE',
      entityType: 'SUPPLIER_INVOICE',
      entityId: invoice._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Marked invoice #${invoice.invoiceNumber} as CLEARED with final payment of ₹${outstanding} to "${invoice.supplierName}" (Receipt: ${receiptNo})`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Invoice #${invoice.invoiceNumber} marked as CLEARED. Recorded final payment of ₹${outstanding}. Receipt: ${receiptNo}`,
      data: {
        invoice: invoice.toJSON(),
        paymentRecord: clearancePayment,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/dashboard/stats
export const getSupplierStats = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { dateFrom, dateTo } = req.query;

    const invoiceQuery: any = {};
    if (dateFrom && dateTo) {
      invoiceQuery.invoiceDate = { $gte: String(dateFrom), $lte: String(dateTo) };
    } else if (dateFrom) {
      invoiceQuery.invoiceDate = { $gte: String(dateFrom) };
    } else if (dateTo) {
      invoiceQuery.invoiceDate = { $lte: String(dateTo) };
    }

    const allSuppliers = await Supplier.find({ active: true });
    const totalSuppliers = allSuppliers.length;

    const invoices = await SupplierInvoice.find(invoiceQuery);
    const totalInvoicesReceived = invoices.length;

    let netPurchaseAmount = 0;
    let totalPaid = 0;
    let totalAdvance = 0;
    let clearedInvoicesCount = 0;
    let pendingInvoicesCount = 0;

    invoices.forEach((inv) => {
      netPurchaseAmount += inv.netPrice || 0;
      totalPaid += inv.totalPaid || 0;
      totalAdvance += inv.advanceAmount || 0;
      if (inv.paymentStatus === 'CLEARED') {
        clearedInvoicesCount++;
      } else {
        pendingInvoicesCount++;
      }
    });

    const totalOutstandingBalance = Math.max(0, netPurchaseAmount - totalPaid);

    // Active Suppliers: suppliers who have made at least 1 transaction in the selected date range
    // (or default last 6 months if no range given)
    const activeSupplierNames = new Set<string>();
    invoices.forEach((inv) => {
      if (inv.supplierName) activeSupplierNames.add(inv.supplierName.toLowerCase().trim());
    });
    const activeSuppliers = activeSupplierNames.size;

    res.json({
      success: true,
      message: 'Supplier dashboard metrics',
      data: {
        totalSuppliers,
        totalInvoicesReceived,
        activeSuppliers,
        netPurchaseAmount,
        totalPaid,
        totalOutstandingBalance,
        totalAdvance,
        clearedInvoicesCount,
        pendingInvoicesCount,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/receipt/:receiptNumber
export const getSupplierPaymentReceipt = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const receiptNum = req.params.receiptNumber.trim().toUpperCase();
    const invoice = await SupplierInvoice.findOne({
      'paymentHistory.receiptNumber': receiptNum,
    });

    if (!invoice) {
      res.status(404).json({ success: false, message: 'Supplier payment receipt not found', data: null });
      return;
    }

    const paymentRecord = invoice.paymentHistory.find((p) => p.receiptNumber === receiptNum);
    const supplier = await Supplier.findOne({
      supplierName: new RegExp(`^${invoice.supplierName}$`, 'i'),
    });

    res.json({
      success: true,
      message: 'Supplier payment receipt details',
      data: {
        receiptNumber: receiptNum,
        supplierName: invoice.supplierName,
        supplierContact: supplier ? {
          contactPerson: supplier.contactPerson,
          mobileNumber: supplier.mobileNumber,
          email: supplier.email,
          address: supplier.address,
        } : null,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        paymentDate: paymentRecord?.date || invoice.invoiceDate,
        paymentTime: paymentRecord?.time || invoice.invoiceTime,
        products: invoice.products,
        frameQuantity: invoice.frameQuantity,
        lensQuantity: invoice.lensQuantity,
        totalQuantity: invoice.totalQuantity,
        netInvoiceAmount: invoice.netPrice,
        amountPaidNow: paymentRecord?.amount || 0,
        remainingBalance: paymentRecord?.remainingBalance ?? invoice.balanceAmount,
        paymentMethod: paymentRecord?.paymentMethod || invoice.paymentType,
        paymentStatus: invoice.paymentStatus,
        recordedByName: paymentRecord?.recordedByName || 'Admin',
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/export-excel
export const exportSupplierInvoicesExcel = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoices = await SupplierInvoice.find().sort({ invoiceDate: -1 });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SRI SAI SMART OPTICALS';
    const worksheet = workbook.addWorksheet('Supplier Purchases');

    worksheet.columns = [
      { header: 'Invoice Number', key: 'invoiceNumber', width: 18 },
      { header: 'Supplier Name', key: 'supplierName', width: 24 },
      { header: 'Invoice Date', key: 'invoiceDate', width: 14 },
      { header: 'Total Quantity', key: 'totalQuantity', width: 14 },
      { header: 'Frame Qty', key: 'frameQuantity', width: 12 },
      { header: 'Lens Qty', key: 'lensQuantity', width: 12 },
      { header: 'Net Price (₹)', key: 'netPrice', width: 16 },
      { header: 'Total Paid (₹)', key: 'totalPaid', width: 16 },
      { header: 'Balance Amount (₹)', key: 'balanceAmount', width: 18 },
      { header: 'Payment Status', key: 'paymentStatus', width: 16 },
      { header: 'Payment Type', key: 'paymentType', width: 14 },
    ];

    const headerRow = worksheet.getRow(1);
    headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF172554' },
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 26;

    invoices.forEach((inv) => {
      worksheet.addRow({
        invoiceNumber: inv.invoiceNumber,
        supplierName: inv.supplierName,
        invoiceDate: inv.invoiceDate,
        totalQuantity: inv.totalQuantity,
        frameQuantity: inv.frameQuantity,
        lensQuantity: inv.lensQuantity,
        netPrice: inv.netPrice,
        totalPaid: inv.totalPaid,
        balanceAmount: inv.balanceAmount,
        paymentStatus: inv.paymentStatus,
        paymentType: inv.paymentType,
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Supplier_Purchases_${getIndianDateStr()}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// ============================================================================
// SUPPLIER PDF DOCUMENT REPOSITORY (Requirement 2: Quotations & Invoices Archive)
// ============================================================================

// POST /api/suppliers/documents/upload
export const uploadSupplierDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Please select a PDF document to upload', data: null });
      return;
    }

    if (req.file.size > MAX_PDF_FILE_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        message: 'PDF file exceeds the 15 MB maximum size limit',
        data: null,
      });
      return;
    }

    const { supplierName, invoiceNumber, documentDate, documentType, notes } = req.body;

    if (!supplierName || !String(supplierName).trim()) {
      res.status(400).json({ success: false, message: 'Supplier Name is required', data: null });
      return;
    }

    if (!invoiceNumber || !String(invoiceNumber).trim()) {
      res.status(400).json({ success: false, message: 'Invoice / Quotation Number is required', data: null });
      return;
    }

    const cleanSupplier = String(supplierName).trim();
    const cleanInvNum = String(invoiceNumber).trim().toUpperCase();
    const cleanDocDate = documentDate ? String(documentDate).trim() : getIndianDateStr();
    const cleanDocType = String(documentType || 'INVOICE').trim().toUpperCase() === 'QUOTATION' ? 'QUOTATION' : 'INVOICE';
    const cleanNotes = String(notes || '').trim();

    const targetPathname = buildSupplierPdfBlobPathname(cleanSupplier, req.file.originalname);
    const mimeType = req.file.mimetype || 'application/pdf';

    const blob = await uploadPrivatePdfBlob(targetPathname, req.file.buffer, mimeType);

    const doc = await SupplierDocument.create({
      supplierName: cleanSupplier,
      invoiceNumber: cleanInvNum,
      documentDate: cleanDocDate,
      documentType: cleanDocType,
      notes: cleanNotes,
      originalFileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType,
      blobPathname: blob.pathname,
      blobUrl: blob.url,
      uploadedBy: req.user?.id || 'admin',
      uploadedByName: req.user?.fullName || 'Admin',
    });

    await AuditLog.create({
      action: 'UPLOAD_SUPPLIER_DOCUMENT',
      entityType: 'SUPPLIER_DOCUMENT',
      entityId: doc._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: JSON.stringify({
        supplierName: cleanSupplier,
        invoiceNumber: cleanInvNum,
        documentType: cleanDocType,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        blobPathname: blob.pathname,
      }),
    });

    res.json({
      success: true,
      message: `Supplier ${cleanDocType.toLowerCase()} #${cleanInvNum} uploaded and archived securely!`,
      data: doc.toJSON(),
    });
  } catch (error: any) {
    console.error('uploadSupplierDocument error:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to upload supplier PDF document', data: null });
  }
};

// GET /api/suppliers/documents
export const getSupplierDocuments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const supplierName = req.query.supplierName ? String(req.query.supplierName).trim() : '';
    const documentType = req.query.documentType ? String(req.query.documentType).trim().toUpperCase() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};
    if (supplierName) {
      query.supplierName = new RegExp(`^${supplierName}$`, 'i');
    }
    if (documentType && (documentType === 'INVOICE' || documentType === 'QUOTATION')) {
      query.documentType = documentType;
    }
    if (dateFrom && dateTo) {
      query.documentDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.documentDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.documentDate = { $lte: dateTo };
    }

    if (search) {
      const sRegex = new RegExp(search, 'i');
      query.$or = [
        { supplierName: sRegex },
        { invoiceNumber: sRegex },
        { originalFileName: sRegex },
        { notes: sRegex },
      ];
    }

    const docs = await SupplierDocument.find(query).sort({ documentDate: -1, createdAt: -1 });

    res.json({
      success: true,
      message: 'Supplier documents retrieved',
      data: docs.map((d) => d.toJSON()),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/suppliers/documents/:id/download
export const downloadSupplierDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await SupplierDocument.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: 'Supplier document record not found', data: null });
      return;
    }

    const blobRef = doc.blobPathname || doc.blobUrl;
    if (!blobRef) {
      res.status(404).json({ success: false, message: 'Document storage path missing', data: null });
      return;
    }

    const blobResult = await getPrivatePdfBlob(blobRef);
    if (!blobResult || blobResult.statusCode !== 200 || !blobResult.stream) {
      res.status(404).json({
        success: false,
        message: 'Original PDF file could not be found in Vercel Blob Private Storage',
        data: null,
      });
      return;
    }

    const safeAsciiName = doc.originalFileName.replace(/[^a-zA-Z0-9._ -]/g, '_');

    res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(doc.originalFileName)}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (blobResult.blob.size) {
      res.setHeader('Content-Length', String(blobResult.blob.size));
    }

    const nodeStream = Readable.fromWeb(blobResult.stream as any);
    nodeStream.on('error', (streamErr) => {
      console.error('Private Blob stream error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming file from private storage' });
      } else {
        res.end();
      }
    });

    nodeStream.pipe(res);
  } catch (error: any) {
    console.error('downloadSupplierDocument error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message || 'Failed to download document' });
    }
  }
};

// GET /api/suppliers/documents/:id/view
export const viewSupplierDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await SupplierDocument.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: 'Supplier document record not found', data: null });
      return;
    }

    const blobRef = doc.blobPathname || doc.blobUrl;
    if (!blobRef) {
      res.status(404).json({ success: false, message: 'Document storage path missing', data: null });
      return;
    }

    const blobResult = await getPrivatePdfBlob(blobRef);
    if (!blobResult || blobResult.statusCode !== 200 || !blobResult.stream) {
      res.status(404).json({
        success: false,
        message: 'Original PDF file could not be found in Vercel Blob Private Storage',
        data: null,
      });
      return;
    }

    const safeAsciiName = doc.originalFileName.replace(/[^a-zA-Z0-9._ -]/g, '_');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(doc.originalFileName)}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (blobResult.blob.size) {
      res.setHeader('Content-Length', String(blobResult.blob.size));
    }

    const nodeStream = Readable.fromWeb(blobResult.stream as any);
    nodeStream.on('error', (streamErr) => {
      console.error('Private Blob stream error:', streamErr.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming file from private storage' });
      } else {
        res.end();
      }
    });

    nodeStream.pipe(res);
  } catch (error: any) {
    console.error('viewSupplierDocument error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message || 'Failed to view document' });
    }
  }
};

// DELETE /api/suppliers/documents/:id
export const deleteSupplierDocument = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const doc = await SupplierDocument.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ success: false, message: 'Supplier document record not found', data: null });
      return;
    }

    if (doc.blobPathname || doc.blobUrl) {
      try {
        await deletePrivatePdfBlob(doc.blobPathname || doc.blobUrl);
      } catch (delErr: any) {
        console.warn('Could not delete blob file:', delErr.message);
      }
    }

    await SupplierDocument.findByIdAndDelete(req.params.id);

    await AuditLog.create({
      action: 'DELETE_SUPPLIER_DOCUMENT',
      entityType: 'SUPPLIER_DOCUMENT',
      entityId: req.params.id,
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: JSON.stringify({
        supplierName: doc.supplierName,
        invoiceNumber: doc.invoiceNumber,
        originalFileName: doc.originalFileName,
      }),
    });

    res.json({
      success: true,
      message: 'Supplier document removed from repository',
      data: null,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

