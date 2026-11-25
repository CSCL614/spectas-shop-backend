import { Router } from 'express';
import multer from 'multer';
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  getSupplierProfile,
  getSupplierInvoices,
  getSupplierProducts,
  createSupplierInvoice,
  updateSupplierInvoice,
  recordSupplierPayment,
  markSupplierInvoiceCleared,
  getSupplierStats,
  getSupplierPaymentReceipt,
  exportSupplierInvoicesExcel,
  importSupplierInvoicesExcel,
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

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (
      name.endsWith('.xlsx') ||
      name.endsWith('.xls') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
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
router.post('/import-excel', excelUpload.single('file'), importSupplierInvoicesExcel);
router.get('/receipt/:receiptNumber', getSupplierPaymentReceipt);
router.get('/products', getSupplierProducts);
router.get('/invoices', getSupplierInvoices);
router.post('/invoices', createSupplierInvoice);
router.put('/invoices/:id', updateSupplierInvoice);
router.patch('/invoices/:id', updateSupplierInvoice);
router.post('/invoices/:id/payments', recordSupplierPayment);
router.patch('/invoices/:id/mark-clear', markSupplierInvoiceCleared);

router.get('/', getSuppliers);
router.post('/', createSupplier);
router.put('/:id', updateSupplier);
router.patch('/:id', updateSupplier);
router.get('/:id', getSupplierProfile);

export default router;
