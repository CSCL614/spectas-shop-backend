import { Response } from 'express';
import { Readable } from 'stream';
import ExcelJS from 'exceljs';
import { AuthRequest } from '../types';
import { Sale } from '../models/Sale';
import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { UploadedFile } from '../models/UploadedFile';
import { Counter } from '../models/Counter';
import { getNextAtomicStickerNumber, getIndianDateStr } from './salesController';
import {
  MAX_EXCEL_FILE_SIZE_BYTES,
  isExcelFileName,
  buildExcelBlobPathname,
  uploadPrivateExcelBlob,
  createScopedExcelUploadToken,
  getPrivateExcelBlob,
  readPrivateExcelBlobToBuffer,
  deletePrivateExcelBlob,
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

const resolveTargetSalesperson = async (
  req: AuthRequest,
  explicitSalespersonId?: string
): Promise<{ salespersonId: string; salespersonName: string }> => {
  let salespersonId = req.user?.id || '';
  let salespersonName = req.user?.fullName || 'User';

  if (req.user?.role === 'ADMIN' && explicitSalespersonId) {
    const sp = await User.findById(explicitSalespersonId);
    if (sp) {
      salespersonId = sp._id.toString();
      salespersonName = sp.fullName;
    }
  }

  return { salespersonId, salespersonName };
};

interface ProcessExcelParams {
  req: AuthRequest;
  fileBuffer: Buffer;
  originalFileName: string;
  fileSize: number;
  mimeType: string;
  blobPathname: string;
  blobUrl: string;
  salespersonId: string;
  salespersonName: string;
}

const processExcelBufferAndPersistMetadata = async ({
  req,
  fileBuffer,
  originalFileName,
  fileSize,
  mimeType,
  blobPathname,
  blobUrl,
  salespersonId,
  salespersonName,
}: ProcessExcelParams) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    throw new Error('Worksheet is empty');
  }

  const errors: { rowNumber: number; field: string; error: string; rawValue?: any }[] = [];
  const salesToInsert: any[] = [];
  const existingRawStickers: string[] = await Sale.distinct('stickerNumber');
  const existingStickers = new Set<string>();
  let highestSeq = 1000;

  existingRawStickers.forEach((st) => {
    const upper = String(st || '').trim().toUpperCase();
    if (!upper) return;
    existingStickers.add(upper);
    const digits = upper.match(/\d+/g);
    if (digits && digits.length > 0) {
      const num = parseInt(digits[digits.length - 1], 10);
      if (!isNaN(num)) {
        existingStickers.add(`STK-${num}`);
        if (num > highestSeq) highestSeq = num;
      }
    }
  });

  const todayStr = getIndianDateStr();
  const timeStr = getIndianTimeStr();

  const rowsData: { rowNumber: number; row: ExcelJS.Row }[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Header row
    rowsData.push({ rowNumber, row });
  });

  // Detect column indices dynamically from row 1
  const headerRow = worksheet.getRow(1);
  const colMap: Record<string, number> = {};
  headerRow.eachCell((cell, colNumber) => {
    const txt = String(cell.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (txt.includes('sticker') || txt.includes('unique') || txt.includes('code') || txt === 'id') colMap['stickerNumber'] = colNumber;
    else if (txt.includes('company') || (txt.includes('brand') && !txt.includes('unique'))) colMap['companyName'] = colNumber;
    else if (txt === 'frames' || txt === 'frame') colMap['frames'] = colNumber;
    else if (txt === 'lenses' || txt === 'lens' || txt === 'lense') colMap['lenses'] = colNumber;
    else if (txt.includes('type') || txt.includes('category')) colMap['productType'] = colNumber;
    else if (txt.includes('quantity') || txt === 'qty' || txt === 'stock') colMap['quantity'] = colNumber;
    else if (txt.includes('cost')) colMap['costPrice'] = colNumber;
    else if (txt.includes('selling') || txt.includes('mrp') || txt.includes('orig')) colMap['originalSellingPrice'] = colNumber;
    else if (txt.includes('discounttype')) colMap['discountType'] = colNumber;
    else if (txt.includes('discountval') || txt.includes('discountvalue')) colMap['discountValue'] = colNumber;
    else if (txt.includes('advance')) colMap['advanceAmount'] = colNumber;
    else if (txt.includes('payment') || txt.includes('method')) colMap['paymentMethod'] = colNumber;
    else if (txt.includes('deliverydate') || txt.includes('expected')) colMap['expectedDeliveryDate'] = colNumber;
    else if (txt.includes('deliverystatus') || txt.includes('status')) colMap['deliveryStatus'] = colNumber;
    else if (txt.includes('customername') || txt.includes('customer') || txt.includes('patient')) colMap['customerName'] = colNumber;
    else if (txt.includes('mobile') || txt.includes('phone') || txt.includes('contact')) colMap['customerMobile'] = colNumber;
  });

  const getCellVal = (row: ExcelJS.Row, idx?: number) => {
    if (!idx) return '';
    const val = row.getCell(idx).value;
    if (val === null || val === undefined) return '';
    if (typeof val === 'object' && (val as any).text) return String((val as any).text).trim();
    if (val instanceof Date) return val.toISOString().split('T')[0];
    return String(val).trim();
  };

  const hasFramesCol = !!colMap['frames'] || !!colMap['lenses'];

  for (const { rowNumber, row } of rowsData) {
    const sticker = getCellVal(row, colMap['stickerNumber'] || 1).toUpperCase();
    const company = getCellVal(row, colMap['companyName'] || 2);
    const rawFrames = getCellVal(row, colMap['frames'] || (hasFramesCol ? 3 : 0));
    const rawLenses = getCellVal(row, colMap['lenses'] || (hasFramesCol ? 4 : 0));
    const rawType = getCellVal(row, colMap['productType'] || (!hasFramesCol ? 3 : 0)).toUpperCase();
    const rawQty = getCellVal(row, colMap['quantity'] || (hasFramesCol ? 5 : 0));
    const rawCost = getCellVal(row, colMap['costPrice'] || (hasFramesCol ? 6 : 4));
    const rawOrigSelling = getCellVal(row, colMap['originalSellingPrice'] || (hasFramesCol ? 7 : 5));
    const rawDiscType = getCellVal(row, colMap['discountType'] || (hasFramesCol ? 8 : 6)).toUpperCase();
    const rawDiscVal = getCellVal(row, colMap['discountValue'] || (hasFramesCol ? 9 : 7));
    const rawAdvance = getCellVal(row, colMap['advanceAmount'] || (hasFramesCol ? 10 : 8));
    const rawPayMethod = getCellVal(row, colMap['paymentMethod'] || (hasFramesCol ? 11 : 9));
    const rawDelDate = getCellVal(row, colMap['expectedDeliveryDate'] || (hasFramesCol ? 12 : 10));
    const rawDelStatus = getCellVal(row, colMap['deliveryStatus'] || (hasFramesCol ? 13 : 11)).toUpperCase();
    const custName = getCellVal(row, colMap['customerName'] || (hasFramesCol ? 14 : 12));
    const custMobile = getCellVal(row, colMap['customerMobile'] || (hasFramesCol ? 15 : 13));

    if (!sticker && !company && !custName) continue; // Empty row

    if (!company) {
      errors.push({ rowNumber, field: 'Company / Brand', error: 'Company brand name is required' });
      continue;
    }

    // Determine Product Type: Frames vs Lenses rules
    const hasFrames = rawFrames && rawFrames.trim() !== '-' && rawFrames.trim() !== '' && rawFrames.trim() !== '0';
    const hasLenses = rawLenses && rawLenses.trim() !== '-' && rawLenses.trim() !== '' && rawLenses.trim() !== '0';

    if (hasFrames && hasLenses) {
      errors.push({
        rowNumber,
        field: 'Frames / Lenses',
        error: 'A product cannot have both Frames and Lenses populated. Specify "Frames" with "-" for Lenses, or "-" for Frames with "Lenses".',
      });
      continue;
    }

    let productType = 'FRAME';
    if (hasFrames) {
      productType = 'FRAME';
    } else if (hasLenses) {
      productType = 'LENS';
    } else if (rawType) {
      if (rawType === 'FRAME' || rawType === 'LENS') {
        productType = rawType;
      } else {
        errors.push({ rowNumber, field: 'Product Type', error: "Must be 'Frame' or 'Lens'", rawValue: rawType });
        continue;
      }
    } else {
      errors.push({
        rowNumber,
        field: 'Frames / Lenses',
        error: "Please specify 'Frames' in Frames column or 'Lenses' in Lenses column (with '-' in the other column)",
      });
      continue;
    }

    const itemQuantity = Math.max(1, parseInt(rawQty, 10) || 1);

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
      continue;
    }

    // Normalize or auto-generate sticker number in STK-XXXX format
    let normalizedSticker = sticker;
    if (!normalizedSticker) {
      normalizedSticker = await getNextAtomicStickerNumber();
      while (existingStickers.has(normalizedSticker)) {
        normalizedSticker = await getNextAtomicStickerNumber();
      }
    } else {
      if (/^\d+$/.test(normalizedSticker)) {
        normalizedSticker = `STK-${normalizedSticker}`;
      } else if (!normalizedSticker.startsWith('STK-')) {
        const numMatch = normalizedSticker.match(/(\d+)/);
        if (numMatch) {
          normalizedSticker = `STK-${numMatch[1]}`;
        }
      }
      if (existingStickers.has(normalizedSticker) || existingStickers.has(sticker)) {
        errors.push({
          rowNumber,
          field: 'Sticker Number',
          error: 'Duplicate sticker number already exists',
          rawValue: sticker,
        });
        continue;
      }
    }

    const stDigits = normalizedSticker.match(/\d+/g);
    if (stDigits && stDigits.length > 0) {
      const num = parseInt(stDigits[stDigits.length - 1], 10);
      if (!isNaN(num) && num > highestSeq) highestSeq = num;
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

    existingStickers.add(normalizedSticker);

    salesToInsert.push({
      stickerNumber: normalizedSticker,
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
      paymentTransactions:
        advanceAmount > 0
          ? [
              {
                amount: advanceAmount,
                paymentMethod: validPayMethod,
                date: todayStr,
                time: timeStr,
                notes: 'Excel Bulk Import Initial Payment',
                receivedBy: req.user?.id,
                receivedByName: req.user?.fullName,
              },
            ]
          : [],
      expectedDeliveryDate: rawDelDate || todayStr,
      deliveryStatus: validDelStatus,
      deliveredAt: validDelStatus === 'DELIVERED' ? new Date() : undefined,
      deliveredBy: validDelStatus === 'DELIVERED' ? salespersonName : undefined,
      customerName: custName || 'Walk-in Customer',
      customerMobile: cleanMobile,
      saleDate: todayStr,
      salespersonId,
      salespersonName,
    });
  }

  if (salesToInsert.length > 0) {
    await Sale.insertMany(salesToInsert);
    // Sync atomic sticker counter with highest imported sequence
    const counter = await Counter.findById('stickerNumber');
    if (!counter) {
      await Counter.create({ _id: 'stickerNumber', seq: highestSeq });
    } else if (counter.seq < highestSeq) {
      counter.seq = highestSeq;
      await counter.save();
    }
  }

  const totalRows = salesToInsert.length + errors.length;
  const status: 'SUCCESS' | 'PARTIAL' | 'FAILED' =
    errors.length === 0 ? 'SUCCESS' : salesToInsert.length > 0 ? 'PARTIAL' : 'FAILED';

  // Save cloud file metadata in MongoDB (no local disk paths)
  const uploadedDoc = await UploadedFile.create({
    originalFileName,
    storedFileName: blobPathname,
    blobPathname,
    blobUrl,
    storageProvider: 'VERCEL_BLOB',
    filePath: blobPathname,
    fileSize,
    mimeType: mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    salespersonId,
    salespersonName,
    uploadDate: todayStr,
    uploadTime: timeStr,
    totalRows,
    successCount: salesToInsert.length,
    errorCount: errors.length,
    status,
  });

  await AuditLog.create({
    action: 'EXCEL_IMPORT',
    entityType: 'SALE',
    entityId: uploadedDoc._id.toString(),
    performedBy: req.user?.id || 'system',
    performedByName: req.user?.fullName || 'User',
    details: `Uploaded "${originalFileName}" to Vercel Blob Private Storage and imported ${salesToInsert.length} orders (${errors.length} rejections)`,
    timestamp: new Date().toISOString(),
  });

  return {
    totalRows,
    successCount: salesToInsert.length,
    errorCount: errors.length,
    errors,
    uploadedFile: uploadedDoc.toJSON(),
  };
};

export const downloadTemplate = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sales Import Template');

    sheet.columns = [
      { header: 'Sticker Number*', key: 'stickerNumber', width: 18 },
      { header: 'Company Name*', key: 'companyName', width: 20 },
      { header: 'Frames', key: 'frames', width: 14 },
      { header: 'Lenses', key: 'lenses', width: 14 },
      { header: 'Quantity*', key: 'quantity', width: 14 },
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

    sheet.addRow({
      stickerNumber: 'STK-1001',
      companyName: 'Ray-Ban',
      frames: 'Frames',
      lenses: '-',
      quantity: 10,
      costPrice: 2800,
      originalSellingPrice: 4500,
      discountType: 'FIXED',
      discountValue: 500,
      advanceAmount: 2000,
      paymentMethod: 'UPI',
      expectedDeliveryDate: '2026-11-20',
      deliveryStatus: 'PENDING',
      customerName: 'Aarav Mehta',
      customerMobile: '9876543210',
    });

    sheet.addRow({
      stickerNumber: 'STK-1002',
      companyName: 'Essilor',
      frames: '-',
      lenses: 'Lenses',
      quantity: 20,
      costPrice: 1500,
      originalSellingPrice: 2500,
      discountType: 'PERCENTAGE',
      discountValue: 10,
      advanceAmount: 2250,
      paymentMethod: 'Cash',
      expectedDeliveryDate: '2026-11-18',
      deliveryStatus: 'DELIVERED',
      customerName: 'Priya Reddy',
      customerMobile: '9845012345',
    });

    sheet.addRow({
      stickerNumber: 'STK-1003',
      companyName: 'Oakley',
      frames: 'Frames',
      lenses: '-',
      quantity: 5,
      costPrice: 3200,
      originalSellingPrice: 5200,
      discountType: 'NONE',
      discountValue: 0,
      advanceAmount: 3000,
      paymentMethod: 'Debit Card',
      expectedDeliveryDate: '2026-11-22',
      deliveryStatus: 'PENDING',
      customerName: 'Vikram Singh',
      customerMobile: '9812345678',
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sri_sai_smart_opticals_template.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Step 1 of Direct Client Upload (supports files up to 10 MB on Vercel, bypassing the 4.5 MB serverless body limit).
 * Issues a short-lived, path-scoped Vercel Blob client upload token without exposing BLOB_READ_WRITE_TOKEN.
 */
export const createBlobUploadToken = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { fileName, fileSize, salespersonId: explicitSalespersonId } = req.body || {};

    if (!fileName || !isExcelFileName(fileName)) {
      res.status(400).json({
        success: false,
        message: 'Only valid Excel spreadsheet files (.xlsx or .xls) are permitted',
        data: null,
      });
      return;
    }

    const numericSize = Number(fileSize) || 0;
    if (numericSize <= 0) {
      res.status(400).json({
        success: false,
        message: 'Uploaded file appears to be empty',
        data: null,
      });
      return;
    }

    if (numericSize > MAX_EXCEL_FILE_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        message: 'File size exceeds the maximum allowed limit of 10 MB',
        data: null,
      });
      return;
    }

    const { salespersonId, salespersonName } = await resolveTargetSalesperson(
      req,
      explicitSalespersonId ? String(explicitSalespersonId) : undefined
    );

    const pathname = buildExcelBlobPathname(salespersonId, fileName);
    const clientToken = await createScopedExcelUploadToken(pathname);

    res.json({
      success: true,
      message: 'Scoped private upload token generated',
      data: {
        clientToken,
        pathname,
        maxFileSizeBytes: MAX_EXCEL_FILE_SIZE_BYTES,
        salespersonId,
        salespersonName,
      },
    });
  } catch (error: any) {
    console.error('createBlobUploadToken error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to authorize cloud storage upload',
      data: null,
    });
  }
};

/**
 * Step 2 of Direct Client Upload:
 * Reads the already-uploaded private Excel file from Vercel Blob via `get()`,
 * runs existing ExcelJS order validation & MongoDB import, and records cloud metadata.
 */
export const importSalesFromBlob = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      blobPathname,
      blobUrl,
      originalFileName,
      fileSize,
      mimeType,
      salespersonId: explicitSalespersonId,
    } = req.body || {};

    const cleanPathname = String(blobPathname || '').trim();
    const cleanUrl = String(blobUrl || '').trim();
    const cleanOriginalName = String(originalFileName || '').trim();

    if (!cleanPathname || !cleanOriginalName) {
      res.status(400).json({
        success: false,
        message: 'Missing uploaded blob reference or filename',
        data: null,
      });
      return;
    }

    if (!cleanPathname.startsWith('excel-sheets/') || cleanPathname.includes('..')) {
      res.status(403).json({
        success: false,
        message: 'Invalid blob storage pathname',
        data: null,
      });
      return;
    }

    if (!isExcelFileName(cleanOriginalName)) {
      res.status(400).json({
        success: false,
        message: 'Only Excel (.xlsx or .xls) files are supported',
        data: null,
      });
      return;
    }

    // Enforce strict Sales Executive path isolation
    if (req.user?.role === 'SALESPERSON' && !cleanPathname.startsWith(`excel-sheets/${req.user.id}/`)) {
      res.status(403).json({
        success: false,
        message: 'Access denied: Unauthorized blob path',
        data: null,
      });
      return;
    }

    const numericSize = Number(fileSize) || 0;
    if (numericSize > MAX_EXCEL_FILE_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        message: 'File size exceeds maximum 10 MB limit',
        data: null,
      });
      return;
    }

    const { salespersonId, salespersonName } = await resolveTargetSalesperson(
      req,
      explicitSalespersonId ? String(explicitSalespersonId) : undefined
    );

    // Securely fetch the private Excel file from Vercel Blob Storage using `get()`
    const fileBuffer = await readPrivateExcelBlobToBuffer(cleanPathname);

    const importResult = await processExcelBufferAndPersistMetadata({
      req,
      fileBuffer,
      originalFileName: cleanOriginalName,
      fileSize: numericSize || fileBuffer.length,
      mimeType: String(mimeType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      blobPathname: cleanPathname,
      blobUrl: cleanUrl || cleanPathname,
      salespersonId,
      salespersonName,
    });

    res.json({
      success: true,
      message: `Import complete: ${importResult.successCount} imported, ${importResult.errorCount} rejected.`,
      data: importResult,
    });
  } catch (error: any) {
    console.error('importSalesFromBlob error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process Excel file from Vercel Blob',
      data: null,
    });
  }
};

/**
 * Direct Server Upload (`POST /api/excel/import`):
 * Uses Vercel Blob `put()` with `access: 'private'` (zero local filesystem writes).
 * Suitable for files <= 4.5 MB on Vercel Serverless or direct API uploads.
 */
export const importSales = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: 'Please upload an Excel (.xlsx or .xls) file', data: null });
      return;
    }

    if (!isExcelFileName(req.file.originalname)) {
      res.status(400).json({
        success: false,
        message: 'Only Excel (.xlsx or .xls) files are permitted',
        data: null,
      });
      return;
    }

    if (req.file.size > MAX_EXCEL_FILE_SIZE_BYTES) {
      res.status(400).json({
        success: false,
        message: 'File exceeds the 10 MB maximum limit',
        data: null,
      });
      return;
    }

    const { salespersonId, salespersonName } = await resolveTargetSalesperson(
      req,
      req.query.salespersonId ? String(req.query.salespersonId) : undefined
    );

    // Upload original Excel file to Vercel Blob Private Storage using `put()` (NO local mkdir/writeFile!)
    const targetPathname = buildExcelBlobPathname(salespersonId, req.file.originalname);
    const mimeType =
      req.file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    const blob = await uploadPrivateExcelBlob(targetPathname, req.file.buffer, mimeType);

    const importResult = await processExcelBufferAndPersistMetadata({
      req,
      fileBuffer: req.file.buffer,
      originalFileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType,
      blobPathname: blob.pathname,
      blobUrl: blob.url,
      salespersonId,
      salespersonName,
    });

    res.json({
      success: true,
      message: `Import complete: ${importResult.successCount} imported, ${importResult.errorCount} rejected.`,
      data: importResult,
    });
  } catch (error: any) {
    console.error('importSales error:', error.message);
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

export const getUploadedSheetById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = await UploadedFile.findById(req.params.id);
    if (!file) {
      res.status(404).json({ success: false, message: 'Uploaded file record not found', data: null });
      return;
    }

    if (req.user?.role === 'SALESPERSON' && file.salespersonId !== req.user.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied: You do not have permission to view this file',
        data: null,
      });
      return;
    }

    res.json({
      success: true,
      message: 'Uploaded file metadata retrieved',
      data: file.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

/**
 * Authenticated Private Vercel Blob Download Endpoint (`GET /api/excel/uploaded-sheets/:id/download`):
 * Uses `get(pathname, { access: 'private' })` and securely streams the Excel file to authorized users.
 */
export const downloadUploadedSheet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = await UploadedFile.findById(req.params.id);
    if (!file) {
      res.status(404).json({ success: false, message: 'Uploaded file record not found', data: null });
      return;
    }

    // Strict RBAC verification: Admin can access all files; Sales Executives only their own
    if (req.user?.role === 'SALESPERSON' && file.salespersonId !== req.user.id) {
      res.status(403).json({
        success: false,
        message: 'Access denied: You are only permitted to download your own uploaded files',
        data: null,
      });
      return;
    }

    const blobRef = file.blobPathname || file.blobUrl;
    if (!blobRef) {
      res.status(404).json({
        success: false,
        message: 'This legacy file was uploaded before Vercel Blob Private Storage was enabled and is no longer available.',
        data: null,
      });
      return;
    }

    const blobResult = await getPrivateExcelBlob(blobRef);
    if (!blobResult || blobResult.statusCode !== 200 || !blobResult.stream) {
      res.status(404).json({
        success: false,
        message: 'Original Excel file could not be found in Vercel Blob Private Storage',
        data: null,
      });
      return;
    }

    const contentType =
      file.mimeType ||
      blobResult.blob.contentType ||
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const safeAsciiName = file.originalFileName.replace(/[^a-zA-Z0-9._ -]/g, '_');

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodeURIComponent(file.originalFileName)}`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (blobResult.blob.size) {
      res.setHeader('Content-Length', String(blobResult.blob.size));
    }

    // Stream private Blob directly to HTTP response
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
    console.error('downloadUploadedSheet error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message || 'Failed to download file' });
    }
  }
};

export const deleteUploadedSheet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({
        success: false,
        message: 'Access denied: Only Administrators can delete Excel sheets',
        data: null,
      });
      return;
    }

    const file = await UploadedFile.findById(req.params.id);
    if (!file) {
      res.status(404).json({ success: false, message: 'Excel sheet record not found', data: null });
      return;
    }

    const blobRef = file.blobUrl || file.blobPathname;
    if (blobRef) {
      try {
        await deletePrivateExcelBlob(blobRef);
      } catch (blobErr: any) {
        // Log non-fatal blob deletion warning so orphaned DB metadata can still be cleaned up
        console.warn('Warning deleting private Excel blob:', blobErr?.message || blobErr);
      }
    }

    await UploadedFile.findByIdAndDelete(file._id);

    await AuditLog.create({
      action: 'DELETE_EXCEL_SHEET',
      entityType: 'EXCEL',
      entityId: file._id.toString(),
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: `Deleted uploaded Excel sheet "${file.originalFileName}" (originally uploaded by ${file.salespersonName})`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Excel sheet "${file.originalFileName}" deleted successfully`,
      data: null,
    });
  } catch (error: any) {
    console.error('deleteUploadedSheet error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete Excel sheet',
      data: null,
    });
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
    workbook.creator = 'SRI SAI SMART OPTICALS SOFTWARE';
    workbook.description = 'A Clear Vision for Better Business';
    const sheet = workbook.addWorksheet('Sri Sai Smart Opticals');

    sheet.columns = [
      { header: 'Sticker Number', key: 'stickerNumber', width: 16 },
      { header: 'Company Name', key: 'companyName', width: 20 },
      { header: 'Frames', key: 'frames', width: 14 },
      { header: 'Lenses', key: 'lenses', width: 14 },
      { header: 'Quantity', key: 'quantity', width: 14 },
      { header: 'Cost Price (₹)', key: 'costPrice', width: 16 },
      { header: 'Original Selling Price (₹)', key: 'sellingPrice', width: 18 },
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
      const isFrame = s.productType === 'FRAME';
      const qty = s.items && s.items.length > 0 ? s.items.reduce((acc: number, it: any) => acc + (it.quantity || 1), 0) : 1;
      sheet.addRow({
        stickerNumber: s.stickerNumber,
        companyName: s.companyName,
        frames: isFrame ? 'Frames' : '-',
        lenses: !isFrame ? 'Lenses' : '-',
        quantity: qty,
        costPrice: s.costPrice,
        sellingPrice: s.originalSellingPrice || s.sellingPrice,
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
    res.setHeader('Content-Disposition', 'attachment; filename="sri_sai_smart_opticals_export.xlsx"');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
