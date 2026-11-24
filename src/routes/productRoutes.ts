import { Router } from 'express';
import multer from 'multer';
import {
  getProducts,
  searchCatalog,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getInventoryLogs,
  downloadMasterProductTemplate,
  exportProductsExcel,
  importProductsExcel,
} from '../controllers/productController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';
import { MAX_EXCEL_FILE_SIZE_BYTES } from '../utils/blobStorage';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EXCEL_FILE_SIZE_BYTES },
});

router.use(authMiddleware);

// Public catalog search & view for authenticated users (Admin + Sales Executive)
router.get('/search-catalog', searchCatalog);
router.get('/excel-template', downloadMasterProductTemplate);
router.get('/excel-export', exportProductsExcel);
router.get('/', getProducts);
router.get('/inventory-logs', requireAdmin, getInventoryLogs);
router.get('/:id', getProductById);

// Admin-only management endpoints
router.post('/', requireAdmin, createProduct);
router.put('/:id', requireAdmin, updateProduct);
router.delete('/:id', requireAdmin, deleteProduct);
router.post('/excel-import', requireAdmin, upload.single('file'), importProductsExcel);

export default router;
