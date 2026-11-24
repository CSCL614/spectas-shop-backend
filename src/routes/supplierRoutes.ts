import { Router } from 'express';
import multer from 'multer';
import {
  getSuppliers,
  createSupplier,
  getSupplierProfile,
  getSupplierInvoices,
  createSupplierInvoice,
  recordSupplierPayment,
  markSupplierInvoiceCleared,
  getSupplierStats,
  getSupplierPaymentReceipt,
  exportSupplierInvoicesExcel,
  uploadSupplierDocument,
  getSupplierDocuments,
  downloadSupplierDocument,
  viewSupplierDocument,
  deleteSupplierDocument,
} from '../controllers/supplierController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';

const router = Router();

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF documents (.pdf) are allowed'));
    }
  },
});

router.use(authMiddleware);
router.use(requireAdmin); // Supplier operations are Admin-only

// Supplier PDF Document Repository (Requirement 2)
router.post('/documents/upload', pdfUpload.single('file'), uploadSupplierDocument);
router.get('/documents', getSupplierDocuments);
router.get('/documents/:id/download', downloadSupplierDocument);
router.get('/documents/:id/view', viewSupplierDocument);
router.delete('/documents/:id', deleteSupplierDocument);

router.get('/dashboard/stats', getSupplierStats);
router.get('/export-excel', exportSupplierInvoicesExcel);
router.get('/receipt/:receiptNumber', getSupplierPaymentReceipt);
router.get('/invoices', getSupplierInvoices);
router.post('/invoices', createSupplierInvoice);
router.post('/invoices/:id/payments', recordSupplierPayment);
router.patch('/invoices/:id/mark-clear', markSupplierInvoiceCleared);

router.get('/', getSuppliers);
router.post('/', createSupplier);
router.get('/:id', getSupplierProfile);

export default router;
