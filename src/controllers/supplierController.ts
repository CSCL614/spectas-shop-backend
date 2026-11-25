import { Response } from 'express';
import ExcelJS from 'exceljs';
import { Readable } from 'stream';
import { AuthRequest, ISupplierInvoiceProduct } from '../types';
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

// PUT /api/suppliers/:id
export const updateSupplier = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { supplierName, contactPerson, mobileNumber, email, address, active } = req.body;

    let supplier: ISupplier | null = null;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      supplier = await Supplier.findById(id);
    }
    if (!supplier) {
      supplier = await Supplier.findOne({
        supplierName: new RegExp(`^${decodeURIComponent(id).trim()}$`, 'i'),
      });
    }

    if (!supplier) {
      res.status(404).json({ success: false, message: 'Supplier not found', data: null });
      return;
    }

    const oldName = supplier.supplierName;
    const newName = supplierName ? String(supplierName).trim() : oldName;

    // Check duplicate name if renaming
    if (newName.toLowerCase() !== oldName.toLowerCase()) {
      const existing = await Supplier.findOne({
        _id: { $ne: supplier._id },
        supplierName: new RegExp(`^${newName}$`, 'i'),
      });
      if (existing) {
        res.status(400).json({
          success: false,
          message: `Supplier "${newName}" already exists`,
          data: null,
        });
        return;
      }
      supplier.supplierName = newName;
    }

    if (contactPerson !== undefined) supplier.contactPerson = String(contactPerson).trim();
    if (mobileNumber !== undefined) supplier.mobileNumber = String(mobileNumber).trim();
    if (email !== undefined) supplier.email = String(email).trim().toLowerCase();
    if (address !== undefined) supplier.address = String(address).trim();
    if (active !== undefined) supplier.active = Boolean(active);

    await supplier.save();

    // Propagate updated supplier name, contact person, mobile number to invoices
    await SupplierInvoice.updateMany(
      {
        $or: [
          { supplierId: supplier._id },
          { supplierName: new RegExp(`^${oldName}$`, 'i') },
        ],
      },
      {
        $set: {
          supplierName: supplier.supplierName,
          contactPerson: supplier.contactPerson,
          mobileNumber: supplier.mobileNumber,
        },
      }
    );

    await AuditLog.create({
      action: 'UPDATE_SUPPLIER',
      entityType: 'SUPPLIER',
      entityId: supplier._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Updated supplier details for "${supplier.supplierName}"`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Supplier details updated successfully',
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

// GET /api/suppliers/products
export const getSupplierProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const supplierName = req.query.supplierName ? String(req.query.supplierName).trim() : '';
    const brandName = req.query.brandName ? String(req.query.brandName).trim() : '';
    const productIdentification = req.query.productIdentification ? String(req.query.productIdentification).trim() : '';
    const invoiceNumber = req.query.invoiceNumber ? String(req.query.invoiceNumber).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const date = req.query.date ? String(req.query.date).trim() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};

    // Search only by supplier name (Requirement 5)
    if (search) {
      query.supplierName = new RegExp(search.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }
    if (supplierName) {
      query.supplierName = new RegExp(`^${supplierName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i');
    }
    if (productIdentification) {
      query['products.productIdentification'] = new RegExp(productIdentification.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }
    if (brandName) {
      query['products.brandName'] = new RegExp(brandName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }
    if (invoiceNumber) {
      query.invoiceNumber = new RegExp(invoiceNumber.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }
    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query['products.productType'] = productType;
    }
    if (date) {
      query.invoiceDate = date;
    } else if (dateFrom && dateTo) {
      query.invoiceDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.invoiceDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.invoiceDate = { $lte: dateTo };
    }

    const invoices = await SupplierInvoice.find(query).sort({ invoiceDate: -1, createdAt: -1 });

    // Fetch all catalog products to connect supplier products with stock info and indicators
    const catalogProducts = await Product.find({ active: true });
    const productMap = new Map<string, any>();
    catalogProducts.forEach((cp) => {
      productMap.set(cp.brandUniqueNumber.toUpperCase(), cp);
    });

    // Grouping to determine OLD STOCK vs NEW STOCK if multiple unique numbers exist for brand + identification
    const groupLatestDate = new Map<string, string>();
    invoices.forEach((inv) => {
      inv.products.forEach((p) => {
        const brand = String(p.brandName || '').trim().toUpperCase();
        const ident = String(p.productIdentification || '').trim().toUpperCase();
        const key = `${brand}::${ident}`;
        const curLatest = groupLatestDate.get(key) || '';
        if (inv.invoiceDate > curLatest) {
          groupLatestDate.set(key, inv.invoiceDate);
        }
      });
    });

    const items: any[] = [];
    invoices.forEach((inv) => {
      inv.products.forEach((p) => {
        if (brandName && !new RegExp(brandName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i').test(p.brandName)) {
          return;
        }
        if (productIdentification && !new RegExp(productIdentification.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i').test(p.productIdentification || '')) {
          return;
        }
        if (productType && p.productType !== productType) {
          return;
        }

        const brand = String(p.brandName || '').trim().toUpperCase();
        const ident = String(p.productIdentification || '').trim().toUpperCase();
        const key = `${brand}::${ident}`;
        const latestDate = groupLatestDate.get(key) || inv.invoiceDate;

        const matchedCatalog = productMap.get((p.brandUniqueNumber || '').toUpperCase());
        const stockIndicator = matchedCatalog?.stockBatchType || (inv.invoiceDate >= latestDate ? 'NEW STOCK' : 'OLD STOCK');

        const unitCost = p.unitCost || 0;
        const qty = p.quantity || 1;
        const totalCost = p.totalCost || (unitCost * qty);

        items.push({
          id: `${inv._id}_${p.brandUniqueNumber}`,
          invoiceId: inv._id.toString(),
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          supplierName: inv.supplierName,
          brandName: p.brandName,
          productIdentification: p.productIdentification || '—',
          brandUniqueNumber: p.brandUniqueNumber,
          productType: p.productType,
          quantity: qty,
          unitCost,
          totalCost,
          stockIndicator,
          catalogStock: matchedCatalog ? matchedCatalog.quantity : qty,
          sellingPrice: matchedCatalog ? matchedCatalog.price : 0,
        });
      });
    });

    res.json({
      success: true,
      message: 'Supplier product details retrieved',
      data: items,
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
    const productIdentification = req.query.productIdentification ? String(req.query.productIdentification).trim() : '';
    const invoiceNumber = req.query.invoiceNumber ? String(req.query.invoiceNumber).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus).trim().toUpperCase() : '';
    const date = req.query.date ? String(req.query.date).trim() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};

    // Requirement 5: Search ONLY by Supplier Name
    // Case-insensitive, partial matching on supplierName ONLY.
    if (search) {
      const reg = new RegExp(search.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      query.supplierName = reg;
    }

    if (supplierName) {
      query.supplierName = new RegExp(`^${supplierName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i');
    }

    if (productIdentification) {
      query['products.productIdentification'] = new RegExp(productIdentification.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }

    if (brandName) {
      query['products.brandName'] = new RegExp(brandName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }

    if (invoiceNumber) {
      query.invoiceNumber = new RegExp(invoiceNumber.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
    }

    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query['products.productType'] = productType;
    }

    if (paymentStatus && ['CLEARED', 'PARTIAL', 'PENDING'].includes(paymentStatus)) {
      query.paymentStatus = paymentStatus;
    }

    if (date) {
      query.invoiceDate = date;
    } else if (dateFrom && dateTo) {
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

    const paymentRecordIndex = invoice.paymentHistory.findIndex((p) => p.receiptNumber === receiptNum);
    const paymentRecord = paymentRecordIndex >= 0 ? invoice.paymentHistory[paymentRecordIndex] : undefined;
    const previousPayments = invoice.paymentHistory
      .slice(0, paymentRecordIndex >= 0 ? paymentRecordIndex : 0)
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const supplier = await Supplier.findOne({
      supplierName: new RegExp(`^${invoice.supplierName}$`, 'i'),
    });

    const contactPerson = supplier?.contactPerson || invoice.contactPerson || 'Authorized Representative';
    const contactNumber = supplier?.mobileNumber || invoice.mobileNumber || '';

    res.json({
      success: true,
      message: 'Supplier payment receipt details',
      data: {
        receiptNumber: receiptNum,
        supplierName: invoice.supplierName,
        contactPerson,
        contactNumber,
        supplierContact: supplier ? {
          contactPerson: supplier.contactPerson,
          mobileNumber: supplier.mobileNumber,
          email: supplier.email,
          address: supplier.address,
        } : {
          contactPerson,
          mobileNumber: contactNumber,
          email: '',
          address: '',
        },
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        paymentDate: paymentRecord?.date || invoice.invoiceDate,
        paymentTime: paymentRecord?.time || invoice.invoiceTime,
        products: invoice.products,
        frameQuantity: invoice.frameQuantity,
        lensQuantity: invoice.lensQuantity,
        totalQuantity: invoice.totalQuantity,
        netInvoiceAmount: invoice.netPrice,
        previousPayments,
        amountPaidNow: paymentRecord?.amount || 0,
        amountPaid: paymentRecord?.amount || 0,
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

// Helper: Format invoice time to readable format (e.g. 11:30 AM)
export const formatReadableTime = (rawTime?: string): string => {
  if (!rawTime || !String(rawTime).trim()) return '';
  const trimmed = String(rawTime).trim();
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (match24) {
    let hours = parseInt(match24[1], 10);
    const minutes = match24[2];
    if (hours >= 0 && hours <= 23) {
      const period = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      if (hours === 0) hours = 12;
      return `${hours}:${minutes} ${period}`;
    }
  }
  return trimmed;
};

// GET /api/suppliers/export-excel
export const exportSupplierInvoicesExcel = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoices = await SupplierInvoice.find().sort({ invoiceDate: -1, createdAt: -1 });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SRI SAI SMART OPTICALS';
    const worksheet = workbook.addWorksheet('Supplier Purchases');

    worksheet.columns = [
      { header: 'Supplier Name', key: 'supplierName', width: 26 },
      { header: 'Contact Person', key: 'contactPerson', width: 22 },
      { header: 'Invoice Number', key: 'invoiceNumber', width: 18 },
      { header: 'Invoice Date', key: 'invoiceDate', width: 14 },
      { header: 'Invoice Time', key: 'invoiceTime', width: 14 },
      { header: 'Brand Name', key: 'brandName', width: 18 },
      { header: 'Product Identification', key: 'productIdentification', width: 26 },
      { header: 'Unique Number', key: 'uniqueNumber', width: 16 },
      { header: 'Category', key: 'category', width: 14 },
      { header: 'Quantity', key: 'quantity', width: 12 },
      { header: 'Price', key: 'price', width: 14 },
      { header: 'Net Invoice Amount', key: 'netInvoiceAmount', width: 20 },
      { header: 'Advance Amount', key: 'advanceAmount', width: 16 },
      { header: 'Balance Amount', key: 'balanceAmount', width: 16 },
      { header: 'Payment Method', key: 'paymentMethod', width: 16 },
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
      const invTime = formatReadableTime(inv.invoiceTime);
      if (inv.products && inv.products.length > 0) {
        inv.products.forEach((p) => {
          worksheet.addRow({
            supplierName: inv.supplierName,
            contactPerson: inv.contactPerson || '',
            invoiceNumber: inv.invoiceNumber,
            invoiceDate: inv.invoiceDate,
            invoiceTime: invTime,
            brandName: p.brandName || '',
            productIdentification: p.productIdentification || '',
            uniqueNumber: p.brandUniqueNumber || '',
            category: p.productType === 'LENS' ? 'Lens' : 'Frame',
            quantity: p.quantity || 1,
            price: p.unitCost !== undefined ? p.unitCost : 0,
            netInvoiceAmount: inv.netPrice || 0,
            advanceAmount: inv.advanceAmount || 0,
            balanceAmount: inv.balanceAmount || 0,
            paymentMethod: inv.paymentType || 'Cash',
          });
        });
      } else {
        worksheet.addRow({
          supplierName: inv.supplierName,
          contactPerson: inv.contactPerson || '',
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDate,
          invoiceTime: invTime,
          brandName: '',
          productIdentification: '',
          uniqueNumber: '',
          category: '',
          quantity: inv.totalQuantity || 0,
          price: 0,
          netInvoiceAmount: inv.netPrice || 0,
          advanceAmount: inv.advanceAmount || 0,
          balanceAmount: inv.balanceAmount || 0,
          paymentMethod: inv.paymentType || 'Cash',
        });
      }
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

// POST /api/suppliers/import-excel
export const importSupplierInvoicesExcel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Please select an Excel file (.xlsx, .xls) to upload', data: null });
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as any);
    const worksheet = workbook.worksheets[0];

    if (!worksheet || worksheet.rowCount < 2) {
      res.status(400).json({ success: false, message: 'The uploaded Excel file contains no data rows.', data: null });
      return;
    }

    // Find header row and map columns
    let headerRowIndex = 1;
    let colMap: Record<string, number> = {};

    for (let r = 1; r <= Math.min(10, worksheet.rowCount); r++) {
      const row = worksheet.getRow(r);
      const tempMap: Record<string, number> = {};
      row.eachCell((cell, colNumber) => {
        const text = String(cell.value || '').trim().toLowerCase();
        if (text.includes('supplier') && !text.includes('receipt')) tempMap.supplierName = colNumber;
        else if (text.includes('contact person') || text === 'contact') tempMap.contactPerson = colNumber;
        else if (text.includes('mobile') || text.includes('phone')) tempMap.mobileNumber = colNumber;
        else if (text.includes('invoice number') || text.includes('invoice #') || text.includes('invoice no') || text === 'inv no' || text === 'invoice') tempMap.invoiceNumber = colNumber;
        else if (text.includes('invoice date') || text === 'date') tempMap.invoiceDate = colNumber;
        else if (text.includes('invoice time') || text === 'time') tempMap.invoiceTime = colNumber;
        else if (text.includes('brand')) tempMap.brandName = colNumber;
        else if (text.includes('identification') || text.includes('model') || text.includes('product name') || text === 'description' || text === 'particulars') tempMap.productIdentification = colNumber;
        else if (text.includes('unique') || text.includes('sticker') || text.includes('item code') || text === 'code') tempMap.uniqueNumber = colNumber;
        else if (text.includes('category') || text.includes('product type') || text === 'type') tempMap.category = colNumber;
        else if (text.includes('qty') || text.includes('quantity')) tempMap.quantity = colNumber;
        else if (text.includes('price') || text.includes('rate') || text.includes('unit cost') || text.includes('cost')) tempMap.price = colNumber;
        else if (text.includes('net') || text.includes('total amount') || text.includes('invoice amount')) tempMap.netInvoiceAmount = colNumber;
        else if (text.includes('advance')) tempMap.advanceAmount = colNumber;
        else if (text.includes('method') || text.includes('payment mode') || text.includes('payment type')) tempMap.paymentMethod = colNumber;
        else if (text.includes('note') || text.includes('remark')) tempMap.notes = colNumber;
      });

      if (tempMap.invoiceNumber && (tempMap.supplierName || tempMap.brandName || tempMap.price || tempMap.uniqueNumber)) {
        colMap = tempMap;
        headerRowIndex = r;
        break;
      }
    }

    if (!colMap.invoiceNumber || !colMap.supplierName) {
      res.status(400).json({
        success: false,
        message: 'Could not detect required columns "Supplier Name" and "Invoice Number" in Excel header. Please ensure standard column names.',
        data: null,
      });
      return;
    }

    // Group rows by supplierName + '|||' + invoiceNumber
    interface RawInvoiceGroup {
      supplierName: string;
      contactPerson: string;
      mobileNumber: string;
      invoiceNumber: string;
      invoiceDate: string;
      invoiceTime: string;
      netInvoiceAmount: number;
      advanceAmount: number;
      paymentMethod: string;
      notes: string;
      items: any[];
    }

    const groups = new Map<string, RawInvoiceGroup>();

    for (let r = headerRowIndex + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const getVal = (col?: number): string => {
        if (!col) return '';
        const v = row.getCell(col).value;
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && 'text' in (v as any)) return String((v as any).text || '').trim();
        if (v instanceof Date) return v.toISOString().split('T')[0];
        return String(v).trim();
      };

      const invNum = getVal(colMap.invoiceNumber).toUpperCase();
      const supName = getVal(colMap.supplierName);
      if (!invNum || !supName) continue;

      const groupKey = `${supName.toUpperCase()}|||${invNum}`;

      let dateVal = getVal(colMap.invoiceDate);
      if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        if (dateVal.includes('/') || dateVal.includes('-')) {
          const parts = dateVal.split(/[/-]/);
          if (parts.length === 3) {
            if (parts[2].length === 4) {
              dateVal = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
            }
          }
        }
      }
      if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        dateVal = getIndianDateStr();
      }

      const timeVal = formatReadableTime(getVal(colMap.invoiceTime)) || getIndianTimeStr();
      const brand = getVal(colMap.brandName) || 'Optical';
      const identification = getVal(colMap.productIdentification) || `${brand} Model`;
      const uniqueNum = getVal(colMap.uniqueNumber).toUpperCase() || `SUP-${Date.now().toString().slice(-6)}`;
      const rawCat = getVal(colMap.category).toUpperCase();
      const category: 'FRAME' | 'LENS' = rawCat.includes('LENS') ? 'LENS' : 'FRAME';
      const quantity = Math.max(1, parseInt(getVal(colMap.quantity), 10) || 1);
      const price = Math.max(0, parseFloat(getVal(colMap.price)) || 0);
      const rowNet = Math.max(0, parseFloat(getVal(colMap.netInvoiceAmount)) || 0);
      const rowAdvance = Math.max(0, parseFloat(getVal(colMap.advanceAmount)) || 0);
      const rowMethod = getVal(colMap.paymentMethod) || 'Cash';
      const rowNotes = getVal(colMap.notes);

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          supplierName: supName,
          contactPerson: getVal(colMap.contactPerson),
          mobileNumber: getVal(colMap.mobileNumber),
          invoiceNumber: invNum,
          invoiceDate: dateVal,
          invoiceTime: timeVal,
          netInvoiceAmount: rowNet,
          advanceAmount: rowAdvance,
          paymentMethod: rowMethod,
          notes: rowNotes,
          items: [],
        });
      }

      const grp = groups.get(groupKey)!;
      grp.items.push({
        brandName: brand,
        brandUniqueNumber: uniqueNum,
        productType: category,
        productIdentification: identification,
        quantity,
        unitCost: price,
        totalCost: price * quantity,
      });

      if (rowNet > 0 && grp.netInvoiceAmount === 0) grp.netInvoiceAmount = rowNet;
      if (rowAdvance > 0 && grp.advanceAmount === 0) grp.advanceAmount = rowAdvance;
    }

    if (groups.size === 0) {
      res.status(400).json({ success: false, message: 'No valid invoice rows found in the uploaded file.', data: null });
      return;
    }

    const skippedDuplicates: { invoiceNumber: string; supplierName: string }[] = [];
    let importedCount = 0;

    for (const [, grp] of groups) {
      // Safeguard: Check if invoice already exists
      const existing = await SupplierInvoice.findOne({
        supplierName: new RegExp(`^${grp.supplierName.trim()}$`, 'i'),
        invoiceNumber: grp.invoiceNumber.trim().toUpperCase(),
      });

      if (existing) {
        skippedDuplicates.push({
          invoiceNumber: grp.invoiceNumber,
          supplierName: grp.supplierName,
        });
        continue;
      }

      // Ensure Supplier document exists
      let supplierDoc = await Supplier.findOne({
        supplierName: new RegExp(`^${grp.supplierName.trim()}$`, 'i'),
      });
      if (!supplierDoc) {
        supplierDoc = await Supplier.create({
          supplierName: grp.supplierName.trim(),
          contactPerson: grp.contactPerson.trim(),
          mobileNumber: grp.mobileNumber.trim(),
        });
      }

      // Calculate totals
      let totalQty = 0;
      let totalFrames = 0;
      let totalLenses = 0;
      let calculatedTotalCost = 0;

      const normalizedProducts: ISupplierInvoiceProduct[] = grp.items.map((item) => {
        const qty = item.quantity;
        const fQty = item.productType === 'FRAME' ? qty : 0;
        const lQty = item.productType === 'LENS' ? qty : 0;
        totalQty += qty;
        totalFrames += fQty;
        totalLenses += lQty;
        calculatedTotalCost += item.totalCost;

        return {
          brandName: item.brandName,
          brandUniqueNumber: item.brandUniqueNumber,
          productType: item.productType as 'FRAME' | 'LENS',
          productIdentification: item.productIdentification,
          quantity: qty,
          frameQuantity: fQty,
          lensQuantity: lQty,
          unitCost: item.unitCost,
          totalCost: item.totalCost,
        };
      });

      const netPrice = grp.netInvoiceAmount > 0 ? grp.netInvoiceAmount : calculatedTotalCost;
      const advance = Math.min(netPrice, grp.advanceAmount);
      const balance = Math.max(0, netPrice - advance);

      let paymentStatus: 'CLEARED' | 'PARTIAL' | 'PENDING' = 'PENDING';
      if (balance === 0 && netPrice > 0) {
        paymentStatus = 'CLEARED';
      } else if (advance > 0) {
        paymentStatus = 'PARTIAL';
      }

      const paymentHistory: any[] = [];
      if (advance > 0) {
        const receiptNo = await getNextSupplierReceiptNumber();
        paymentHistory.push({
          receiptNumber: receiptNo,
          amount: advance,
          date: grp.invoiceDate,
          time: grp.invoiceTime,
          paymentMethod: grp.paymentMethod,
          remainingBalance: balance,
          recordedBy: req.user?.id || 'admin',
          recordedByName: req.user?.fullName || 'Admin',
          notes: 'Advance recorded via Excel Import',
        });
      }

      const newInvoice = await SupplierInvoice.create({
        invoiceNumber: grp.invoiceNumber,
        supplierId: supplierDoc._id,
        supplierName: grp.supplierName.trim(),
        contactPerson: supplierDoc.contactPerson || grp.contactPerson.trim(),
        mobileNumber: supplierDoc.mobileNumber || grp.mobileNumber.trim(),
        invoiceDate: grp.invoiceDate,
        invoiceTime: grp.invoiceTime,
        products: normalizedProducts,
        totalQuantity: totalQty,
        frameQuantity: totalFrames,
        lensQuantity: totalLenses,
        netPrice,
        advanceAmount: advance,
        totalPaid: advance,
        balanceAmount: balance,
        paymentType: grp.paymentMethod,
        paymentStatus,
        clearedAt: paymentStatus === 'CLEARED' ? new Date() : undefined,
        clearedBy: paymentStatus === 'CLEARED' ? (req.user?.fullName || 'Admin') : undefined,
        paymentHistory,
        notes: grp.notes || 'Imported via Excel spreadsheet',
      });

      // Update product inventory and log SUPPLIER_RECEIVED
      for (const item of normalizedProducts) {
        if (!item.brandUniqueNumber) continue;
        let product = await Product.findOne({ brandUniqueNumber: item.brandUniqueNumber });
        if (!product) {
          product = await Product.create({
            brandName: item.brandName || 'Optical',
            productType: item.productType,
            brandUniqueNumber: item.brandUniqueNumber,
            productIdentification: item.productIdentification || `${item.brandName} (${item.productType})`,
            price: (item.unitCost || 500) * 1.5,
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
            referenceInvoiceNumber: grp.invoiceNumber,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: `Received from supplier "${grp.supplierName}" via Excel import (Invoice #${grp.invoiceNumber})`,
            date: grp.invoiceDate,
            time: grp.invoiceTime,
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
            newStock,
            referenceInvoiceNumber: grp.invoiceNumber,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: `Stock received from supplier "${grp.supplierName}" via Excel import (Invoice #${grp.invoiceNumber})`,
            date: grp.invoiceDate,
            time: grp.invoiceTime,
          });
        }
      }

      await AuditLog.create({
        action: 'IMPORT_SUPPLIER_INVOICE',
        entityType: 'SUPPLIER_INVOICE',
        entityId: newInvoice._id.toString(),
        performedBy: req.user?.id || 'admin',
        performedByName: req.user?.fullName || 'Admin',
        details: `Imported supplier invoice #${grp.invoiceNumber} from "${grp.supplierName}" via Excel`,
        timestamp: new Date().toISOString(),
      });

      importedCount++;
    }

    res.json({
      success: true,
      message: `Import completed: ${importedCount} invoice(s) imported successfully, ${skippedDuplicates.length} duplicate(s) skipped.`,
      data: {
        importedCount,
        skippedCount: skippedDuplicates.length,
        skippedInvoices: skippedDuplicates,
        totalInvoicesInFile: groups.size,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// PUT /api/suppliers/invoices/:id
export const updateSupplierInvoice = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const invoice = await SupplierInvoice.findById(req.params.id);
    if (!invoice) {
      res.status(404).json({ success: false, message: 'Supplier invoice not found', data: null });
      return;
    }

    const {
      supplierName,
      contactPerson = '',
      mobileNumber = '',
      invoiceNumber,
      invoiceDate = invoice.invoiceDate,
      invoiceTime = invoice.invoiceTime,
      products = [],
      netPrice,
      advanceAmount,
      paymentType = invoice.paymentType || 'Cash',
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

    // Check duplicate invoice number (excluding current invoice)
    const existingDup = await SupplierInvoice.findOne({
      _id: { $ne: invoice._id },
      supplierName: new RegExp(`^${cleanSupplierName}$`, 'i'),
      invoiceNumber: cleanInvoiceNum,
    });
    if (existingDup) {
      res.status(400).json({
        success: false,
        message: `Invoice #${cleanInvoiceNum} already exists for supplier "${cleanSupplierName}"`,
        data: null,
      });
      return;
    }

    // Ensure Supplier document exists or update it
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
    const rawList = Array.isArray(products) ? products : [];

    let totalQty = 0;
    let totalFrames = 0;
    let totalLenses = 0;

    const normalizedProducts: ISupplierInvoiceProduct[] = rawList.map((p: any) => {
      const type: 'FRAME' | 'LENS' = String(p.productType || 'FRAME').toUpperCase() === 'LENS' ? 'LENS' : 'FRAME';
      const qty = Math.max(1, parseInt(String(p.quantity || 1), 10));
      const fQty = type === 'FRAME' ? qty : 0;
      const lQty = type === 'LENS' ? qty : 0;

      const uCost = parseFloat(String(p.price !== undefined && p.price !== '' ? p.price : (p.unitCost || 0))) || 0;
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

    // INVENTORY AND STOCK DIFFERENCE SAFEGUARD
    // Map previous products on this invoice
    const oldProductsMap = new Map<string, { qty: number; productType: string; brandName: string; identification: string; unitCost: number }>();
    (invoice.products || []).forEach((p) => {
      const key = (p.brandUniqueNumber || '').trim().toUpperCase();
      if (!key) return;
      const prev = oldProductsMap.get(key) || {
        qty: 0,
        productType: p.productType,
        brandName: p.brandName,
        identification: p.productIdentification || '',
        unitCost: p.unitCost || 0,
      };
      prev.qty += p.quantity;
      oldProductsMap.set(key, prev);
    });

    // Map new products
    const newProductsMap = new Map<string, { qty: number; productType: string; brandName: string; identification: string; unitCost: number }>();
    normalizedProducts.forEach((p) => {
      const key = (p.brandUniqueNumber || '').trim().toUpperCase();
      if (!key) return;
      const prev = newProductsMap.get(key) || {
        qty: 0,
        productType: p.productType,
        brandName: p.brandName,
        identification: p.productIdentification || '',
        unitCost: p.unitCost || 0,
      };
      prev.qty += p.quantity;
      newProductsMap.set(key, prev);
    });

    // Process new and changed products
    for (const [key, newInfo] of newProductsMap) {
      const oldInfo = oldProductsMap.get(key);
      const oldQty = oldInfo ? oldInfo.qty : 0;
      const diff = newInfo.qty - oldQty;

      let product = await Product.findOne({ brandUniqueNumber: key });
      if (!product) {
        // Product didn't exist in master catalog, create it
        product = await Product.create({
          brandName: newInfo.brandName || 'Optical',
          productType: newInfo.productType,
          brandUniqueNumber: key,
          productIdentification: newInfo.identification || `${newInfo.brandName} (${newInfo.productType})`,
          price: (newInfo.unitCost || 500) * 1.5,
          costPrice: newInfo.unitCost,
          quantity: Math.max(0, newInfo.qty),
          frameQuantity: newInfo.productType === 'FRAME' ? Math.max(0, newInfo.qty) : 0,
          lensQuantity: newInfo.productType === 'LENS' ? Math.max(0, newInfo.qty) : 0,
          createdBy: req.user?.username || 'ADMIN',
        });

        await InventoryLog.create({
          productUniqueNumber: key,
          productId: product._id,
          brandName: newInfo.brandName,
          productType: newInfo.productType,
          movementType: 'SUPPLIER_RECEIVED',
          quantity: newInfo.qty,
          previousStock: 0,
          newStock: newInfo.qty,
          referenceInvoiceNumber: cleanInvoiceNum,
          performedBy: req.user?.id || 'admin',
          performedByName: req.user?.fullName || 'Admin',
          notes: `Stock received (added on edited Invoice #${cleanInvoiceNum})`,
          date: invoiceDate,
          time: invoiceTime,
        });
      } else {
        // Product already exists
        const prevStock = product.quantity;
        if (diff > 0) {
          // Additional quantity received
          const newStock = prevStock + diff;
          product.quantity = newStock;
          product.frameQuantity = product.productType === 'FRAME' ? newStock : 0;
          product.lensQuantity = product.productType === 'LENS' ? newStock : 0;
          if (newInfo.unitCost > 0) product.costPrice = newInfo.unitCost;
          if (newInfo.identification) product.productIdentification = newInfo.identification;
          if (newInfo.brandName) product.brandName = newInfo.brandName;
          await product.save();

          await InventoryLog.create({
            productUniqueNumber: key,
            productId: product._id,
            brandName: product.brandName,
            productType: product.productType,
            movementType: 'SUPPLIER_RECEIVED',
            quantity: diff,
            previousStock: prevStock,
            newStock,
            referenceInvoiceNumber: cleanInvoiceNum,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: `Stock adjustment: +${diff} received (Quantity increased on edited Invoice #${cleanInvoiceNum})`,
            date: invoiceDate,
            time: invoiceTime,
          });
        } else if (diff < 0) {
          // Quantity decreased
          const deduct = Math.abs(diff);
          const newStock = Math.max(0, prevStock - deduct);
          product.quantity = newStock;
          product.frameQuantity = product.productType === 'FRAME' ? newStock : 0;
          product.lensQuantity = product.productType === 'LENS' ? newStock : 0;
          if (newInfo.unitCost > 0) product.costPrice = newInfo.unitCost;
          if (newInfo.identification) product.productIdentification = newInfo.identification;
          if (newInfo.brandName) product.brandName = newInfo.brandName;
          await product.save();

          await InventoryLog.create({
            productUniqueNumber: key,
            productId: product._id,
            brandName: product.brandName,
            productType: product.productType,
            movementType: 'STOCK_ADJUSTMENT',
            quantity: -deduct,
            previousStock: prevStock,
            newStock,
            referenceInvoiceNumber: cleanInvoiceNum,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: `Stock adjustment: -${deduct} returned/reduced (Quantity decreased on edited Invoice #${cleanInvoiceNum})`,
            date: invoiceDate,
            time: invoiceTime,
          });
        } else {
          // diff === 0: Quantity unchanged, only update details
          if (newInfo.unitCost > 0) product.costPrice = newInfo.unitCost;
          if (newInfo.identification) product.productIdentification = newInfo.identification;
          if (newInfo.brandName) product.brandName = newInfo.brandName;
          await product.save();
        }
      }
    }

    // Process products that were removed from the invoice
    for (const [key, oldInfo] of oldProductsMap) {
      if (!newProductsMap.has(key)) {
        const product = await Product.findOne({ brandUniqueNumber: key });
        if (product) {
          const prevStock = product.quantity;
          const newStock = Math.max(0, prevStock - oldInfo.qty);
          product.quantity = newStock;
          product.frameQuantity = product.productType === 'FRAME' ? newStock : 0;
          product.lensQuantity = product.productType === 'LENS' ? newStock : 0;
          await product.save();

          await InventoryLog.create({
            productUniqueNumber: key,
            productId: product._id,
            brandName: product.brandName,
            productType: product.productType,
            movementType: 'STOCK_ADJUSTMENT',
            quantity: -oldInfo.qty,
            previousStock: prevStock,
            newStock,
            referenceInvoiceNumber: cleanInvoiceNum,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: `Stock removed: product removed from edited Invoice #${cleanInvoiceNum}`,
            date: invoiceDate,
            time: invoiceTime,
          });
        }
      }
    }

    // FINANCIAL RECALCULATION & PAYMENT PRESERVATION
    const numAdvance = advanceAmount !== undefined ? Math.max(0, parseFloat(String(advanceAmount))) : invoice.advanceAmount;

    // Preserve previous payments; update advance payment if present
    if (invoice.paymentHistory && invoice.paymentHistory.length > 0) {
      const advIdx = invoice.paymentHistory.findIndex(
        (p) => p.notes?.includes('Initial Supplier Advance Payment') || p.notes?.includes('Advance recorded')
      );
      if (advIdx >= 0) {
        invoice.paymentHistory[advIdx].amount = numAdvance;
        invoice.paymentHistory[advIdx].date = invoiceDate;
        invoice.paymentHistory[advIdx].time = invoiceTime || invoice.paymentHistory[advIdx].time;
        invoice.paymentHistory[advIdx].paymentMethod = paymentType;
      } else if (numAdvance > 0 && invoice.advanceAmount === 0) {
        // If there was no advance record before, add one
        const receiptNo = await getNextSupplierReceiptNumber();
        invoice.paymentHistory.unshift({
          receiptNumber: receiptNo,
          amount: numAdvance,
          date: invoiceDate,
          time: invoiceTime,
          paymentMethod: paymentType,
          remainingBalance: Math.max(0, numNetPrice - numAdvance),
          recordedBy: req.user?.id || 'admin',
          recordedByName: req.user?.fullName || 'Admin',
          notes: 'Initial Supplier Advance Payment (Added via Edit)',
        } as any);
      }
    } else if (numAdvance > 0) {
      const receiptNo = await getNextSupplierReceiptNumber();
      invoice.paymentHistory.push({
        receiptNumber: receiptNo,
        amount: numAdvance,
        date: invoiceDate,
        time: invoiceTime,
        paymentMethod: paymentType,
        remainingBalance: Math.max(0, numNetPrice - numAdvance),
        recordedBy: req.user?.id || 'admin',
        recordedByName: req.user?.fullName || 'Admin',
        notes: 'Initial Supplier Advance Payment',
      } as any);
    }

    const updatedTotalPaid = invoice.paymentHistory.reduce((sum, p) => sum + (p.amount || 0), 0);
    const updatedBalance = Math.max(0, numNetPrice - updatedTotalPaid);

    let updatedPaymentStatus: 'CLEARED' | 'PARTIAL' | 'PENDING' = 'PENDING';
    if (updatedBalance === 0 && numNetPrice > 0) {
      updatedPaymentStatus = 'CLEARED';
      if (!invoice.clearedAt) invoice.clearedAt = new Date();
      if (!invoice.clearedBy) invoice.clearedBy = req.user?.fullName || 'Admin';
    } else if (updatedTotalPaid > 0) {
      updatedPaymentStatus = 'PARTIAL';
    }

    // Apply updates to invoice
    invoice.supplierId = supplierDoc._id;
    invoice.supplierName = cleanSupplierName;
    invoice.contactPerson = supplierDoc.contactPerson || String(contactPerson || '').trim();
    invoice.mobileNumber = supplierDoc.mobileNumber || String(mobileNumber || '').trim();
    invoice.invoiceNumber = cleanInvoiceNum;
    invoice.invoiceDate = invoiceDate;
    invoice.invoiceTime = invoiceTime;
    invoice.products = normalizedProducts;
    invoice.totalQuantity = totalQty;
    invoice.frameQuantity = totalFrames;
    invoice.lensQuantity = totalLenses;
    invoice.netPrice = numNetPrice;
    invoice.advanceAmount = numAdvance;
    invoice.totalPaid = updatedTotalPaid;
    invoice.balanceAmount = updatedBalance;
    invoice.paymentType = paymentType;
    invoice.paymentStatus = updatedPaymentStatus;
    invoice.notes = String(notes || '').trim();

    await invoice.save();

    await AuditLog.create({
      action: 'UPDATE_SUPPLIER_INVOICE',
      entityType: 'SUPPLIER_INVOICE',
      entityId: invoice._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Updated supplier purchase record #${cleanInvoiceNum} for supplier "${cleanSupplierName}". Net: ₹${numNetPrice}, Paid: ₹${updatedTotalPaid}, Balance: ₹${updatedBalance}.`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Supplier purchase record updated successfully',
      data: invoice.toJSON(),
    });
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

