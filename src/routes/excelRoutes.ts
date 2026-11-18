import { Router } from 'express';
import multer from 'multer';
import {
  downloadTemplate,
  createBlobUploadToken,
  importSalesFromBlob,
  importSales,
  exportSales,
  getUploadedSheets,
  getUploadedSheetById,
  downloadUploadedSheet,
} from '../controllers/excelController';
import { authMiddleware } from '../middlewares/auth';
import { MAX_EXCEL_FILE_SIZE_BYTES } from '../utils/blobStorage';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EXCEL_FILE_SIZE_BYTES },
});

router.use(authMiddleware);

router.get('/template', downloadTemplate);

// Direct Client Upload flow for Vercel Blob Private Storage (supports up to 10 MB, bypassing Vercel's 4.5 MB limit)
router.post('/blob-upload-token', createBlobUploadToken);
router.post('/import-from-blob', importSalesFromBlob);

// Direct Server Upload endpoint (uses Vercel Blob `put()` with `access: 'private'`, zero local filesystem writes)
router.post('/import', upload.single('file'), importSales);

router.get('/export', exportSales);

// Private Uploaded Excel Sheets metadata & authenticated streaming download (`get()` with `access: 'private'`)
router.get('/uploaded-sheets', getUploadedSheets);
router.get('/uploaded-sheets/:id', getUploadedSheetById);
router.get('/uploaded-sheets/:id/download', downloadUploadedSheet);

export default router;
