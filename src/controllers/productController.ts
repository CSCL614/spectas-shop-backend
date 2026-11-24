import { Response } from 'express';
import ExcelJS from 'exceljs';
import { AuthRequest } from '../types';
import { Product, IProduct } from '../models/Product';
import { InventoryLog } from '../models/InventoryLog';
import { Sale } from '../models/Sale';
import { AuditLog } from '../models/AuditLog';
import { getIndianDateStr } from './salesController';

const getIndianTimeStr = (): string => {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

/**
 * Filter out confidential cost information if user is a SALESPERSON
 */
const sanitizeProduct = (doc: any, isSalesperson: boolean) => {
  const p = doc.toJSON ? doc.toJSON() : { ...doc };
  if (isSalesperson) {
    delete p.costPrice;
  }
  return p;
};

// GET /api/products
export const getProducts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSalesperson = req.user?.role === 'SALESPERSON';
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '20'), 10)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const brandName = req.query.brandName ? String(req.query.brandName).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const stockStatus = req.query.stockStatus ? String(req.query.stockStatus).trim().toUpperCase() : '';

    const query: any = { active: true };

    if (search) {
      const reg = new RegExp(search.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      query.$or = [
        { brandName: reg },
        { brandUniqueNumber: reg },
        { productIdentification: reg },
      ];
    }

    if (brandName) {
      query.brandName = new RegExp(`^${brandName.trim()}$`, 'i');
    }

    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query.productType = productType;
    }

    if (stockStatus === 'OUT_OF_STOCK') {
      query.quantity = { $lte: 0 };
    } else if (stockStatus === 'LOW_STOCK') {
      query.quantity = { $gt: 0, $lte: 5 };
    } else if (stockStatus === 'IN_STOCK') {
      query.quantity = { $gt: 5 };
    }

    const totalElements = await Product.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);
    const products = await Product.find(query)
      .sort({ brandName: 1, brandUniqueNumber: 1 })
      .skip(page * size)
      .limit(size);

    res.json({
      success: true,
      message: 'Products retrieved successfully',
      data: {
        content: products.map((p) => sanitizeProduct(p, isSalesperson)),
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

// GET /api/products/search-catalog
// Fast catalog search for autocomplete in New Order Entry (accessible by both Admin & Sales Executive)
export const searchCatalog = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSalesperson = req.user?.role === 'SALESPERSON';
    const brand = req.query.brand ? String(req.query.brand).trim() : '';
    const productType = req.query.productType ? String(req.query.productType).trim().toUpperCase() : '';
    const q = req.query.q ? String(req.query.q).trim() : '';

    const query: any = { active: true };
    if (brand) {
      query.brandName = new RegExp(`^${brand}$`, 'i');
    }
    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      query.productType = productType;
    }
    if (q) {
      const reg = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      query.$or = [{ brandUniqueNumber: reg }, { productIdentification: reg }, { brandName: reg }];
    }

    const products = await Product.find(query)
      .limit(50)
      .select('-__v')
      .sort({ brandName: 1, brandUniqueNumber: 1 });

    res.json({
      success: true,
      message: 'Product catalog results',
      data: products.map((p) => sanitizeProduct(p, isSalesperson)),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/products/:id
export const getProductById = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const isSalesperson = req.user?.role === 'SALESPERSON';
    let product = null;
    if (req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      product = await Product.findById(req.params.id);
    }
    if (!product) {
      product = await Product.findOne({ brandUniqueNumber: req.params.id.trim().toUpperCase() });
    }

    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found', data: null });
      return;
    }

    res.json({
      success: true,
      message: 'Product retrieved',
      data: sanitizeProduct(product, isSalesperson),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// POST /api/products (Admin only)
export const createProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      brandName,
      productType,
      brandUniqueNumber,
      productIdentification,
      price,
      costPrice = 0,
      quantity = 0,
      lowStockThreshold = 5,
    } = req.body;

    if (!brandName || !productType || !brandUniqueNumber || price === undefined) {
      res.status(400).json({
        success: false,
        message: 'Brand Name, Product Type (FRAME/LENS), Brand Unique Number and Price are required',
        data: null,
      });
      return;
    }

    const cleanUnique = String(brandUniqueNumber).trim().toUpperCase();
    const existing = await Product.findOne({ brandUniqueNumber: cleanUnique });
    if (existing) {
      res.status(400).json({
        success: false,
        message: `Product with unique number "${cleanUnique}" already exists`,
        data: null,
      });
      return;
    }

    const cleanType = String(productType).toUpperCase() === 'LENS' ? 'LENS' : 'FRAME';
    const numQty = Math.max(0, parseInt(String(quantity || 0), 10));
    const numPrice = Math.max(0, parseFloat(String(price || 0)));
    const numCost = Math.max(0, parseFloat(String(costPrice || 0)));

    const product = await Product.create({
      brandName: String(brandName).trim(),
      productType: cleanType,
      brandUniqueNumber: cleanUnique,
      productIdentification: String(productIdentification || '').trim(),
      price: numPrice,
      costPrice: numCost,
      quantity: numQty,
      frameQuantity: cleanType === 'FRAME' ? numQty : 0,
      lensQuantity: cleanType === 'LENS' ? numQty : 0,
      lowStockThreshold: Math.max(0, parseInt(String(lowStockThreshold || 5), 10)),
      createdBy: req.user?.username || 'ADMIN',
    });

    // Record Opening Stock in Ledger if quantity > 0
    if (numQty > 0) {
      await InventoryLog.create({
        productUniqueNumber: cleanUnique,
        productId: product._id,
        brandName: product.brandName,
        productType: cleanType,
        movementType: 'OPENING_STOCK',
        quantity: numQty,
        previousStock: 0,
        newStock: numQty,
        performedBy: req.user?.id || 'admin',
        performedByName: req.user?.fullName || 'Admin',
        notes: 'Initial Opening Stock Entry',
        date: getIndianDateStr(),
        time: getIndianTimeStr(),
      });
    }

    await AuditLog.create({
      action: 'CREATE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: product._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Created product [${cleanUnique}] ${product.brandName} - ${cleanType} (Stock: ${numQty}, Price: ₹${numPrice})`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// PUT /api/products/:id (Admin only)
export const updateProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found', data: null });
      return;
    }

    const {
      brandName,
      productType,
      brandUniqueNumber,
      productIdentification,
      price,
      costPrice,
      quantity,
      lowStockThreshold,
    } = req.body;

    if (brandUniqueNumber) {
      const cleanUnique = String(brandUniqueNumber).trim().toUpperCase();
      if (cleanUnique !== product.brandUniqueNumber) {
        const existing = await Product.findOne({
          brandUniqueNumber: cleanUnique,
          _id: { $ne: product._id },
        });
        if (existing) {
          res.status(400).json({
            success: false,
            message: `Unique number "${cleanUnique}" is already in use by another product`,
            data: null,
          });
          return;
        }
        product.brandUniqueNumber = cleanUnique;
      }
    }

    if (brandName) product.brandName = String(brandName).trim();
    if (productType && (productType === 'FRAME' || productType === 'LENS')) {
      product.productType = productType;
    }
    if (productIdentification !== undefined) {
      product.productIdentification = String(productIdentification).trim();
    }
    if (price !== undefined) {
      product.price = Math.max(0, parseFloat(String(price)));
    }
    if (costPrice !== undefined) {
      product.costPrice = Math.max(0, parseFloat(String(costPrice)));
    }
    if (lowStockThreshold !== undefined) {
      product.lowStockThreshold = Math.max(0, parseInt(String(lowStockThreshold), 10));
    }

    // Explicit Stock Adjustment Handling
    if (quantity !== undefined) {
      const newQty = Math.max(0, parseInt(String(quantity), 10));
      const prevQty = product.quantity;
      if (newQty !== prevQty) {
        product.quantity = newQty;
        product.frameQuantity = product.productType === 'FRAME' ? newQty : 0;
        product.lensQuantity = product.productType === 'LENS' ? newQty : 0;

        await InventoryLog.create({
          productUniqueNumber: product.brandUniqueNumber,
          productId: product._id,
          brandName: product.brandName,
          productType: product.productType,
          movementType: 'STOCK_ADJUSTMENT',
          quantity: newQty - prevQty,
          previousStock: prevQty,
          newStock: newQty,
          performedBy: req.user?.id || 'admin',
          performedByName: req.user?.fullName || 'Admin',
          notes: req.body.stockAdjustmentNotes || 'Manual stock update in Admin Portal',
          date: getIndianDateStr(),
          time: getIndianTimeStr(),
        });
      }
    }

    await product.save();

    await AuditLog.create({
      action: 'UPDATE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: product._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Updated product [${product.brandUniqueNumber}] ${product.brandName} (Stock: ${product.quantity}, Price: ₹${product.price})`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// DELETE /api/products/:id (Admin only)
export const deleteProduct = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      res.status(404).json({ success: false, message: 'Product not found', data: null });
      return;
    }

    // Safe delete check: verify whether orders reference this unique product number
    const linkedSales = await Sale.countDocuments({
      $or: [
        { 'items.brandUniqueNumber': product.brandUniqueNumber },
        { stickerNumber: product.brandUniqueNumber },
      ],
    });

    if (linkedSales > 0) {
      // Soft-delete to preserve data integrity
      product.active = false;
      await product.save();
      res.json({
        success: true,
        message: `Product is referenced in ${linkedSales} existing order(s). It has been safely deactivated instead of deleted.`,
        data: null,
      });
      return;
    }

    await Product.findByIdAndDelete(product._id);

    await AuditLog.create({
      action: 'DELETE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: product._id.toString(),
      performedBy: req.user?.id || 'admin',
      performedByName: req.user?.fullName || 'Admin',
      details: `Deleted product [${product.brandUniqueNumber}] ${product.brandName}`,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: 'Product deleted permanently',
      data: null,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/products/inventory-logs (Admin only)
export const getInventoryLogs = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(0, parseInt(String(req.query.page || '0'), 10));
    const size = Math.max(1, Math.min(100, parseInt(String(req.query.size || '25'), 10)));
    const productUniqueNumber = req.query.productUniqueNumber ? String(req.query.productUniqueNumber).trim().toUpperCase() : '';
    const movementType = req.query.movementType ? String(req.query.movementType).trim() : '';

    const query: any = {};
    if (productUniqueNumber) {
      query.productUniqueNumber = productUniqueNumber;
    }
    if (movementType) {
      query.movementType = movementType;
    }

    const totalElements = await InventoryLog.countDocuments(query);
    const totalPages = Math.ceil(totalElements / size);
    const logs = await InventoryLog.find(query)
      .sort({ createdAt: -1 })
      .skip(page * size)
      .limit(size);

    res.json({
      success: true,
      message: 'Inventory movement history',
      data: {
        content: logs.map((l) => l.toJSON()),
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

// GET /api/products/excel-template
export const downloadMasterProductTemplate = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SRI SAI SMART OPTICALS';
    const worksheet = workbook.addWorksheet('Master Products');

    // Expected Excel Format: Sticker Number, Company Name, Frames, Lenses, Quantity, Cost Price, Original Selling Price
    worksheet.columns = [
      { header: 'Sticker Number', key: 'brandUniqueNumber', width: 18 },
      { header: 'Company Name', key: 'brandName', width: 22 },
      { header: 'Frames', key: 'frames', width: 14 },
      { header: 'Lenses', key: 'lenses', width: 14 },
      { header: 'Quantity', key: 'quantity', width: 14 },
      { header: 'Cost Price', key: 'costPrice', width: 16 },
      { header: 'Original Selling Price', key: 'price', width: 22 },
      { header: 'Product Name', key: 'productName', width: 32 },
    ];

    // Style Header Row
    const headerRow = worksheet.getRow(1);
    headerRow.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF172554' }, // Navy blue
    };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 26;

    // Sample data rows per specifications:
    // If Frame: "Frames" in Frames, "-" in Lenses
    // If Lens: "-" in Frames, "Lenses" in Lenses
    const sampleRows = [
      {
        brandUniqueNumber: 'STK-1001',
        brandName: 'Ray-Ban',
        frames: 'Frames',
        lenses: '-',
        quantity: 10,
        costPrice: 2800,
        price: 4500,
        productName: 'Ray-Ban Aviator Classic',
      },
      {
        brandUniqueNumber: 'STK-1002',
        brandName: 'Essilor',
        frames: '-',
        lenses: 'Lenses',
        quantity: 20,
        costPrice: 1500,
        price: 2500,
        productName: 'Essilor Crizal Prevencia Lens',
      },
      {
        brandUniqueNumber: 'STK-1003',
        brandName: 'Oakley',
        frames: 'Frames',
        lenses: '-',
        quantity: 5,
        costPrice: 3200,
        price: 5200,
        productName: 'Oakley Holbrook Frame',
      },
    ];

    sampleRows.forEach((row) => worksheet.addRow(row));

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.alignment = { vertical: 'middle' };
        row.height = 20;
      }
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="Sri_Sai_Smart_Opticals_Master_Products_Template.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// GET /api/products/excel-export
export const exportProductsExcel = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    const products = await Product.find({ active: true }).sort({ brandName: 1, brandUniqueNumber: 1 });
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SRI SAI SMART OPTICALS';
    const worksheet = workbook.addWorksheet('Master Product Inventory');

    // Expected Excel Format: Sticker Number, Company Name, Frames, Lenses, Quantity, Cost Price, Original Selling Price
    worksheet.columns = [
      { header: 'Sticker Number', key: 'brandUniqueNumber', width: 18 },
      { header: 'Company Name', key: 'brandName', width: 22 },
      { header: 'Frames', key: 'frames', width: 14 },
      { header: 'Lenses', key: 'lenses', width: 14 },
      { header: 'Quantity', key: 'quantity', width: 14 },
      { header: 'Cost Price', key: 'costPrice', width: 16 },
      { header: 'Original Selling Price', key: 'price', width: 22 },
      { header: 'Product Name', key: 'productName', width: 32 },
      { header: 'Stock Status', key: 'stockStatus', width: 16 },
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

    products.forEach((p) => {
      const pJson = p.toJSON();
      worksheet.addRow({
        brandUniqueNumber: p.brandUniqueNumber,
        brandName: p.brandName,
        frames: p.productType === 'FRAME' ? 'Frames' : '-',
        lenses: p.productType === 'LENS' ? 'Lenses' : '-',
        quantity: p.quantity,
        costPrice: p.costPrice || 0,
        price: p.price,
        productName: p.productIdentification || `${p.brandName} (${p.productType})`,
        stockStatus: pJson.stockStatus,
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Master_Products_Inventory_${getIndianDateStr()}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

// POST /api/products/excel-import (Admin only)
export const importProductsExcel = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, message: 'Please upload an Excel (.xlsx) file', data: null });
      return;
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer as any);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      res.status(400).json({ success: false, message: 'Uploaded sheet is empty', data: null });
      return;
    }

    const updateMode = req.query.updateStock === 'true'; // If true, updates stock; if false, updates only details & prices, protecting existing stock!
    const errors: { rowNumber: number; field: string; error: string; rawValue?: any }[] = [];
    let successCount = 0;

    const seenInFile = new Set<string>();

    // Detect column indices dynamically from row 1
    const headerRow = worksheet.getRow(1);
    const colMap: Record<string, number> = {};
    headerRow.eachCell((cell, colNumber) => {
      const txt = String(cell.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (txt.includes('sticker') || txt.includes('unique') || txt.includes('code') || txt === 'id') colMap['brandUniqueNumber'] = colNumber;
      else if (txt.includes('company') || (txt.includes('brand') && !txt.includes('unique'))) colMap['brandName'] = colNumber;
      else if (txt === 'frames' || txt === 'frame') colMap['frames'] = colNumber;
      else if (txt === 'lenses' || txt === 'lens' || txt === 'lense') colMap['lenses'] = colNumber;
      else if (txt.includes('type') || txt.includes('category')) colMap['productType'] = colNumber;
      else if (txt.includes('quantity') || txt === 'qty' || txt === 'stock' || txt.includes('total')) colMap['quantity'] = colNumber;
      else if (txt.includes('cost')) colMap['costPrice'] = colNumber;
      else if (txt.includes('selling') || txt.includes('price') || txt.includes('mrp')) colMap['price'] = colNumber;
      else if (txt.includes('product') || txt.includes('identification') || txt.includes('model') || txt.includes('name')) colMap['productName'] = colNumber;
    });

    const getCellVal = (row: ExcelJS.Row, idx?: number) => {
      if (!idx) return '';
      const val = row.getCell(idx).value;
      if (val === null || val === undefined) return '';
      if (typeof val === 'object' && (val as any).text) return String((val as any).text).trim();
      return String(val).trim();
    };

    const rowsData: { rowNumber: number; row: ExcelJS.Row }[] = [];
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rowsData.push({ rowNumber, row });
    });

    for (const { rowNumber, row } of rowsData) {
      const brandUniqueNumber = getCellVal(row, colMap['brandUniqueNumber'] || (colMap['productType'] ? 3 : 1));
      const brandName = getCellVal(row, colMap['brandName'] || (colMap['productType'] ? 1 : 2));
      const rawFrames = getCellVal(row, colMap['frames'] || (colMap['productType'] ? 0 : 3));
      const rawLenses = getCellVal(row, colMap['lenses'] || (colMap['productType'] ? 0 : 4));
      const rawQuantity = getCellVal(row, colMap['quantity'] || (colMap['productType'] ? 4 : 5));
      const rawCost = getCellVal(row, colMap['costPrice'] || (colMap['productType'] ? 9 : 6));
      const rawPrice = getCellVal(row, colMap['price'] || (colMap['productType'] ? 8 : 7));
      const productName = getCellVal(row, colMap['productName'] || (colMap['productType'] ? 7 : 8));

      if (!brandName && !brandUniqueNumber) continue; // skip blank row

      if (!brandName) {
        errors.push({ rowNumber, field: 'Company Name', error: 'Company/Brand name is required' });
        continue;
      }

      if (!brandUniqueNumber) {
        errors.push({ rowNumber, field: 'Sticker Number', error: 'Sticker/Unique number is required' });
        continue;
      }

      const cleanUnique = brandUniqueNumber.toUpperCase();
      if (seenInFile.has(cleanUnique)) {
        errors.push({
          rowNumber,
          field: 'Sticker Number',
          error: `Duplicate product identification number "${cleanUnique}" found in sheet`,
        });
        continue;
      }
      seenInFile.add(cleanUnique);

      // Evaluate Frames and Lenses columns per Rule 1, 2, 3:
      // - Frame: "Frames" in Frames, "-" in Lenses
      // - Lens: "-" in Frames, "Lenses" in Lenses
      // - Never populate both columns for a single product row
      const hasFrames = rawFrames && rawFrames.trim() !== '-' && rawFrames.trim() !== '' && rawFrames.trim() !== '0';
      const hasLenses = rawLenses && rawLenses.trim() !== '-' && rawLenses.trim() !== '' && rawLenses.trim() !== '0';

      if (hasFrames && hasLenses) {
        errors.push({
          rowNumber,
          field: 'Frames / Lenses',
          error: 'A product cannot have both Frames and Lenses populated. Specify "Frames" with "-" for Lenses, or "-" for Frames with "Lenses".',
          rawValue: `Frames: "${rawFrames}", Lenses: "${rawLenses}"`,
        });
        continue;
      }

      let productType: 'FRAME' | 'LENS' = 'FRAME';
      if (hasFrames) {
        productType = 'FRAME';
      } else if (hasLenses) {
        productType = 'LENS';
      } else if (colMap['productType']) {
        const rawType = getCellVal(row, colMap['productType']).toUpperCase();
        if (rawType.includes('LENS')) productType = 'LENS';
        else productType = 'FRAME';
      } else {
        errors.push({
          rowNumber,
          field: 'Frames / Lenses',
          error: 'Please specify "Frames" in the Frames column or "Lenses" in the Lenses column (with "-" in the other column).',
        });
        continue;
      }

      const price = parseFloat(rawPrice);
      if (isNaN(price) || price < 0) {
        errors.push({ rowNumber, field: 'Original Selling Price', error: 'Valid non-negative selling price is required', rawValue: rawPrice });
        continue;
      }

      const costPrice = isNaN(parseFloat(rawCost)) ? 0 : Math.max(0, parseFloat(rawCost));
      const quantity = Math.max(0, parseInt(rawQuantity, 10) || 0);
      const frameQuantity = productType === 'FRAME' ? quantity : 0;
      const lensQuantity = productType === 'LENS' ? quantity : 0;

      let existing = await Product.findOne({ brandUniqueNumber: cleanUnique });
      if (existing) {
        // Update product details and prices
        existing.brandName = brandName;
        existing.productType = productType;
        if (productName) existing.productIdentification = productName;
        existing.price = price;
        if (costPrice > 0) existing.costPrice = costPrice;

        // ONLY overwrite stock if updateMode is explicitly requested!
        if (updateMode && quantity >= 0 && quantity !== existing.quantity) {
          const prev = existing.quantity;
          existing.quantity = quantity;
          existing.frameQuantity = frameQuantity;
          existing.lensQuantity = lensQuantity;

          await InventoryLog.create({
            productUniqueNumber: cleanUnique,
            productId: existing._id,
            brandName: existing.brandName,
            productType: existing.productType,
            movementType: 'STOCK_ADJUSTMENT',
            quantity: quantity - prev,
            previousStock: prev,
            newStock: quantity,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: 'Stock updated via Master Product Excel Upload (Frames/Lenses/Quantity format)',
            date: getIndianDateStr(),
            time: getIndianTimeStr(),
          });
        }
        await existing.save();
        successCount++;
      } else {
        // Create new product
        const newProduct = await Product.create({
          brandName,
          productType,
          brandUniqueNumber: cleanUnique,
          productIdentification: productName || `${brandName} (${productType})`,
          price,
          costPrice,
          quantity,
          frameQuantity,
          lensQuantity,
          createdBy: req.user?.username || 'ADMIN',
        });

        if (quantity > 0) {
          await InventoryLog.create({
            productUniqueNumber: cleanUnique,
            productId: newProduct._id,
            brandName,
            productType,
            movementType: 'INITIAL_STOCK',
            quantity,
            previousStock: 0,
            newStock: quantity,
            performedBy: req.user?.id || 'admin',
            performedByName: req.user?.fullName || 'Admin',
            notes: 'Initial stock intake via Master Product Excel Upload (Frames/Lenses/Quantity format)',
            date: getIndianDateStr(),
            time: getIndianTimeStr(),
          });
        }
        successCount++;
      }
    }

    res.json({
      success: true,
      message: `Master products import completed: ${successCount} successful, ${errors.length} error(s)`,
      data: {
        totalRows: rowsData.length,
        successCount,
        errorCount: errors.length,
        errors,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};
