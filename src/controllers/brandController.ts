import { Response } from 'express';
import { AuthRequest } from '../types';
import { Brand } from '../models/Brand';
import { Sale } from '../models/Sale';
import { AuditLog } from '../models/AuditLog';

const DEFAULT_BRANDS = [
  'Ray-Ban',
  'Oakley',
  'Titan Eye+',
  'Fastrack',
  'Vogue',
  'Carrera',
  'Prada',
  'Gucci',
  'Essilor Crizal',
  'Zeiss Vision',
  'Tommy Hilfiger',
  'Polaroid',
  'Lenskart Air',
  'Silhouette',
];

export const initBrandsIfNeeded = async (): Promise<void> => {
  try {
    const count = await Brand.countDocuments();
    if (count === 0) {
      const distinctSalesBrands = await Sale.distinct('companyName');
      const allToSeed = Array.from(new Set([...DEFAULT_BRANDS, ...distinctSalesBrands.filter(Boolean)]));
      const brandDocs = allToSeed.map((name) => ({
        name: String(name).trim(),
        createdBy: 'SYSTEM',
      }));
      await Brand.insertMany(brandDocs, { ordered: false }).catch(() => {});
      console.log(`[Brand] Initialized ${allToSeed.length} brand entries in MongoDB.`);
    }
  } catch (err) {
    console.warn('[Brand] Brand initialization check:', err);
  }
};

export const getAllBrands = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    await initBrandsIfNeeded();
    const brands = await Brand.find().sort({ name: 1 });
    res.json({
      success: true,
      message: 'Brands retrieved successfully',
      data: brands.map((b) => b.toJSON()),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

export const createBrand = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, message: 'Brand name is required', data: null });
      return;
    }

    const cleanName = name.trim();
    const existing = await Brand.findOne({
      name: { $regex: new RegExp(`^${cleanName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'i') },
    });

    if (existing) {
      res.status(400).json({
        success: false,
        message: `Brand "${cleanName}" already exists in the system`,
        data: existing.toJSON(),
      });
      return;
    }

    const brand = await Brand.create({
      name: cleanName,
      createdBy: req.user?.fullName || 'User',
    });

    await AuditLog.create({
      action: 'CREATE_BRAND',
      entityType: 'BRAND',
      entityId: brand._id.toString(),
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.fullName || 'User',
      details: `Added new eyewear brand: ${brand.name}`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      message: `Brand "${brand.name}" added successfully`,
      data: brand.toJSON(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message, data: null });
  }
};

