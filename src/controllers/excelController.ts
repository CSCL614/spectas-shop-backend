import { Response } from 'express';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { AuthRequest } from '../types';
import { Sale } from '../models/Sale';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { UploadedFile } from '../models/UploadedFile';

export const downloadTemplate = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sales Import Template');

    sheet.columns = [
      { header: 'Sticker Number*', key: 'stickerNumber', width: 18 },
      { header: 'Company / Brand*', key: 'companyName', width: 20 },
      { header: 'Product Type (Frame/Lens)*', key: 'productType', width: 26 },
      { header: 'Cost Price*', key: 'costPrice', width: 14 },
      { header: 'Original Selling Price*', key: 'originalSellingPrice', width: 22 },
      { header: 'Discount Type (PERCENTAGE/FIXED/NONE)', key: 'discountType', width: 34 },
      { header: 'Discount Value', key: 'discountValue', width: 16 },
      { header: 'Advance Amount*', key: 'advanceAmount', width: 16 },
      { header: 'Payment Method (Cash/UPI/Debit Card/Credit Card)', key: 'paymentMethod', width: 36 },
      { header: 'Expected Delivery Date (YYYY-MM-DD)*', key: 'expectedDeliveryDate', width: 32 },
      { header: 'Delivery Status (PENDING/DELIVERED)', key: 'deliveryStatus', width: 32 },
      { header: 'Customer Name*', key: 'customerName', width: 22 },
      { header: 'Customer Mobile*', key: 'customerMobile', width: 18 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF172554' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 28;

    // Sample Frame
    sheet.addRow({
      stickerNumber: 'STK-3001',
      companyName: 'Ray-Ban',
      productType: 'Frame',
      costPrice: 2500,
      originalSellingPrice: 5000,
      discountType: 'FIXED',
      discountValue: 500,
      advanceAmount: 2000,
      paymentMethod: 'UPI',
      expectedDeliveryDate: '2026-11-20',
      deliveryStatus: 'PENDING',
      customerName: 'Aarav Mehta',
      customerMobile: '9876543210',
    });

    // Sample Lens
    sheet.addRow({
      stickerNumber: 'STK-3002',
      companyName: 'Essilor Crizal',
      productType: 'Lens',
      costPrice: 1800,
      originalSellingPrice: 4200,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      advanceAmount: 3780,
      paymentMethod: 'Cash',
      expectedDeliveryDate: '2026-11-18',
      deliveryStatus: 'DELIVERED',
      customerName: 'Priya Reddy',
      customerMobile: '9845012345',
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="spectas_sales_template.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const importSales = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Please upload an Excel (.xlsx) file', data: null });
      return;
    }

    let salespersonId = req.user?.id || '';
    let salespersonName = req.user?.fullName || 'User';

    if (req.user?.role === 'ADMIN' && req.query.salespersonId) {
      const sp = await User.findById(req.query.salespersonId);
      if (sp) {
        salespersonId = sp._id.toString();
        salespersonName = sp.fullName;
      }
    }

    // Persist uploaded file to storage for Admin downloads
    const uploadDir = path.join(process.cwd(), 'backend-node', 'uploads', 'excel-sheets');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const timestamp = Date.now();
    const storedFileName = `${timestamp}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const destPath = path.join(uploadDir, storedFileName);
    fs.writeFileSync(destPath, req.file.buffer);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer as any);
    const worksheet = workbook.worksheets[0];

    if (!worksheet) {
      res.status(400).json({ success: false, message: 'Worksheet is empty', data: null });
      return;
    }

    const errors: { rowNumber: number; field: string; error: string; rawValue?: any }[] = [];
    const salesToInsert: any[] = [];
    const existingStickers = new Set(await Sale.distinct('stickerNumber'));
    const todayStr = new Date().toISOString().split('T')[0];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Header row

      const getCell = (idx: number) => {
        const val = row.getCell(idx).value;
        if (val === null || val === undefined) return '';
        if (typeof val === 'object' && (val as any).text) return String((val as any).text).trim();
        return String(val).trim();
      };

      const sticker = getCell(1).toUpperCase();
      const company = getCell(2);
      const rawType = getCell(3).toUpperCase();
      const rawCost = getCell(4);
      const rawOrigSelling = getCell(5);
      const rawDiscType = getCell(6).toUpperCase();
      const rawDiscVal = getCell(7);
      const rawAdvance = getCell(8);
      const rawPayMethod = getCell(9);
      const rawDelDate = getCell(10);
      const rawDelStatus = getCell(11).toUpperCase();
      const custName = getCell(12);
      const custMobile = getCell(13);

      if (!sticker && !company && !custName) return; // Empty row

      if (!sticker) {
        errors.push({ rowNumber, field: 'Sticker Number', error: 'Sticker number is required' });
        return;
      }

      if (existingStickers.has(sticker)) {
        errors.push({ rowNumber, field: 'Sticker Number', error: 'Duplicate sticker number already exists', rawValue: sticker });
        return;
      }

      if (!company) {
        errors.push({ rowNumber, field: 'Company / Brand', error: 'Company brand name is required' });
        return;
      }

      // Validate Product Type
      let productType = 'FRAME';
      if (rawType === 'FRAME' || rawType === 'LENS') {
        productType = rawType;
      } else {
        errors.push({ rowNumber, field: 'Product Type', error: "Must be 'Frame' or 'Lens'", rawValue: rawType });
        return;
      }

      const costPrice = Number(rawCost) || 0;
      const origSelling = Number(rawOrigSelling) || 0;
      const discVal = Number(rawDiscVal) || 0;
      let discType: any = 'NONE';
      if (rawDiscType === 'PERCENTAGE' || rawDiscType === 'FIXED') discType = rawDiscType;

      const cleanMobile = String(custMobile || '').replace(/\D/g, '');
      if (!/^\d{10}$/.test(cleanMobile)) {
        errors.push({
          rowNumber,
          field: 'Customer Mobile',
          error: 'Customer phone number must be exactly 10 digits (digits only)',
          rawValue: custMobile,
        });
        return;
      }

      let discountAmount = 0;
      if (discType === 'PERCENTAGE') discountAmount = Math.round((origSelling * discVal) / 100);
      else if (discType === 'FIXED') discountAmount = discVal;
      discountAmount = Math.max(0, Math.min(origSelling, discountAmount));

      const sellingPrice = Math.max(0, origSelling - discountAmount);
      const advanceAmount = Number(rawAdvance) || 0;
      const remainingBalance = Math.max(0, sellingPrice - advanceAmount);
      const grossProfit = sellingPrice - costPrice;

      const validPayMethod = rawPayMethod || 'Cash';
      const validDelStatus = rawDelStatus === 'DELIVERED' ? 'DELIVERED' : 'PENDING';

      existingStickers.add(sticker);

      salesToInsert.push({
        stickerNumber: sticker,
        companyName: company,
        productType,
        costPrice,
        originalSellingPrice: origSelling,
        discountType: discType,
        discountValue: discVal,
        discountAmount,
        sellingPrice,
        advanceAmount,
        remainingBalance,
        grossProfit,
        paymentMethod: validPayMethod,
        paymentTransactions: advanceAmount > 0 ? [{
          amount: advanceAmount,
          paymentMethod: validPayMethod,
          date: todayStr,
          time: new Date().toLocaleTimeString(),
          notes: 'Excel Bulk Import Initial Payment',
        }] : [],
        expectedDeliveryDate: rawDelDate || todayStr,
        deliveryStatus: validDelStatus,
        customerName: custName || 'Walk-in Customer',
        customerMobile: cleanMobile,
        saleDate: todayStr,
        salespersonId,
        salespersonName,
      });
    });

    if (salesToInsert.length > 0) {
      await Sale.insertMany(salesToInsert);
    }

    const totalRows = salesToInsert.length + errors.length;
    const status = errors.length === 0 ? 'SUCCESS' : (salesToInsert.length > 0 ? 'PARTIAL' : 'FAILED');

    // Save metadata for Admin Excel Sheets page
    await UploadedFile.create({
      originalFileName: req.file.originalname,
      storedFileName,
      filePath: destPath,
      fileSize: req.file.size,
      salespersonId,
      salespersonName,
      uploadDate: todayStr,
      uploadTime: new Date().toLocaleTimeString(),
      totalRows,
      successCount: salesToInsert.length,
      errorCount: errors.length,
      status,
    });

    await AuditLog.create({
      action: 'EXCEL_IMPORT',
      entityType: 'SALE',
      entityId: 'BULK',
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Imported ${salesToInsert.length} orders from "${req.file.originalname}" (${errors.length} rejections)`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Import complete: ${salesToInsert.length} imported, ${errors.length} rejected.`,
      data: {
        totalRows,
        successCount: salesToInsert.length,
        errorCount: errors.length,
        errors,
      },
    });
  } catch (error: any) {
    console.error('importSales error:', error);
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const getUploadedSheets = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const salespersonId = req.query.salespersonId ? String(req.query.salespersonId).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom).trim() : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo).trim() : '';

    const query: any = {};
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    } else if (salespersonId) {
      query.salespersonId = salespersonId;
    }

    if (status) query.status = status;
    if (dateFrom && dateTo) {
      query.uploadDate = { $gte: dateFrom, $lte: dateTo };
    } else if (dateFrom) {
      query.uploadDate = { $gte: dateFrom };
    } else if (dateTo) {
      query.uploadDate = { $lte: dateTo };
    }

    if (search) {
      const regex = { $regex: search, $options: 'i' };
      query.$or = [{ originalFileName: regex }, { salespersonName: regex }];
    }

    const files = await UploadedFile.find(query).sort({ createdAt: -1 });
    res.json({
      success: true,
      message: 'Uploaded sheets retrieved',
      data: files.map((f) => f.toJSON()),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const downloadUploadedSheet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = await UploadedFile.findById(req.params.id);
    if (!file) {
      res.status(404).json({ success: false, message: 'Uploaded file record not found', data: null });
      return;
    }

    if (req.user?.role === 'SALESPERSON' && file.salespersonId !== req.user.id) {
      res.status(403).json({ success: false, message: 'Access denied: You cannot download this file', data: null });
      return;
    }

    if (!fs.existsSync(file.filePath)) {
      res.status(404).json({ success: false, message: 'Original file no longer exists on disk', data: null });
      return;
    }

    res.download(file.filePath, file.originalFileName);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const exportSales = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const query: any = {};
    if (req.user?.role === 'SALESPERSON') {
      query.salespersonId = req.user.id;
    } else if (req.query.salespersonId) {
      query.salespersonId = req.query.salespersonId;
    }

    if (req.query.status) query.deliveryStatus = req.query.status;
    if (req.query.productType) query.productType = req.query.productType;
    if (req.query.paymentMethod) query.paymentMethod = req.query.paymentMethod;
    if (req.query.dateFrom && req.query.dateTo) {
      query.saleDate = { $gte: req.query.dateFrom, $lte: req.query.dateTo };
    }

    const sales = await Sale.find(query).sort({ createdAt: -1 });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Spectas Sales Report');

    sheet.columns = [
      { header: 'Sticker No', key: 'stickerNumber', width: 16 },
      { header: 'Brand / Company', key: 'companyName', width: 20 },
      { header: 'Product Type', key: 'productType', width: 16 },
      { header: 'Cost Price (₹)', key: 'costPrice', width: 16 },
      { header: 'Selling Price (₹)', key: 'sellingPrice', width: 18 },
      { header: 'Advance (₹)', key: 'advanceAmount', width: 16 },
      { header: 'Balance (₹)', key: 'remainingBalance', width: 16 },
      { header: 'Profit (₹)', key: 'grossProfit', width: 16 },
      { header: 'Payment Method', key: 'paymentMethod', width: 18 },
      { header: 'Delivery Status', key: 'deliveryStatus', width: 18 },
      { header: 'Customer Name', key: 'customerName', width: 22 },
      { header: 'Mobile', key: 'customerMobile', width: 16 },
      { header: 'Sale Date', key: 'saleDate', width: 16 },
      { header: 'Sales Executive', key: 'salespersonName', width: 20 },
    ];

    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172554' } };

    sales.forEach((s) => {
      sheet.addRow({
        stickerNumber: s.stickerNumber,
        companyName: s.companyName,
        productType: s.productType || 'UNSPECIFIED',
        costPrice: s.costPrice,
        sellingPrice: s.sellingPrice,
        advanceAmount: s.advanceAmount,
        remainingBalance: s.remainingBalance,
        grossProfit: s.grossProfit,
        paymentMethod: s.paymentMethod,
        deliveryStatus: s.deliveryStatus,
        customerName: s.customerName,
        customerMobile: s.customerMobile,
        saleDate: s.saleDate,
        salespersonName: s.salespersonName,
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="spectas_sales_export.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
