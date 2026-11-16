import { Router } from 'express';
import {
  getAllSales,
  getSaleById,
  createSale,
  updateSale,
  clearBalance,
  deleteSale,
  updateDeliveryStatus,
  getDashboardStats,
  getDailyStatement,
  addPayment,
  getNextStickerNumberPreview,
  getOverdueSales,
  getCustomerProfile,
} from '../controllers/salesController';
import { seedDummySales } from '../utils/seeder';
import { authMiddleware, requireAdmin } from '../middlewares/auth';
import { AuthRequest } from '../types';

const router = Router();

router.use(authMiddleware);

router.get('/dashboard/stats', getDashboardStats);
router.get('/daily-statement', getDailyStatement);
router.get('/next-sticker-number', getNextStickerNumberPreview);
router.get('/overdue', getOverdueSales);
router.get('/customer/:identifier', getCustomerProfile);

router.post('/seed-dummy', requireAdmin, async (_req: AuthRequest, res) => {
  try {
    const count = await seedDummySales(true);
    res.json({ success: true, message: `Seeded ${count} optical orders`, data: { count } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/', getAllSales);
router.post('/', createSale);
router.get('/:id', getSaleById);
router.put('/:id', updateSale);
router.delete('/:id', deleteSale);

router.patch('/:id/delivery-status', updateDeliveryStatus);
router.patch('/:id/clear-balance', clearBalance);
router.post('/:id/payments', addPayment);

export default router;
