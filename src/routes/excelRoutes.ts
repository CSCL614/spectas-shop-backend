import { Router } from 'express';
import multer from 'multer';
import {
  downloadTemplate,
  importSales,
  exportSales,
  getUploadedSheets,
  downloadUploadedSheet,
} from '../controllers/excelController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.use(authMiddleware);

router.get('/template', downloadTemplate);
router.post('/import', upload.single('file'), importSales);
router.get('/export', exportSales);

router.get('/uploaded-sheets', getUploadedSheets);
router.get('/uploaded-sheets/:id/download', downloadUploadedSheet);

export default router;
