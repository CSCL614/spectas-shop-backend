import { put, get, del, type PutBlobResult, type GetBlobResult } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';

export const MAX_EXCEL_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_EXCEL_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'application/octet-stream', // fallback used by some browsers for spreadsheets
];

export const isExcelFileName = (fileName: string): boolean => {
  return /\.(xlsx|xls)$/i.test(String(fileName || '').trim());
};

export const sanitizeFileName = (fileName: string): string => {
  return String(fileName || 'upload.xlsx')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_');
};

export const buildExcelBlobPathname = (ownerUserId: string, originalFileName: string): string => {
  const safeOwner = String(ownerUserId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const safeName = sanitizeFileName(originalFileName);
  const timestamp = Date.now();
  return `excel-sheets/${safeOwner}/${timestamp}_${safeName}`;
};

export const isBlobStorageConfigured = (): boolean => {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)
  );
};

const getBlobAuthOptions = () => {
  const opts: { token?: string; storeId?: string } = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    opts.token = process.env.BLOB_READ_WRITE_TOKEN;
  }
  if (process.env.BLOB_STORE_ID) {
    opts.storeId = process.env.BLOB_STORE_ID;
  }
  return opts;
};

/**
 * Upload an Excel buffer directly from Express server to Vercel Blob Private Storage.
 */
export const uploadPrivateExcelBlob = async (
  pathname: string,
  buffer: Buffer,
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
): Promise<PutBlobResult> => {
  if (!isBlobStorageConfigured()) {
    throw new Error(
      'Vercel Blob Storage is not configured. Please set BLOB_READ_WRITE_TOKEN (and BLOB_STORE_ID) in backend environment variables.'
    );
  }

  return put(pathname, buffer, {
    access: 'private',
    addRandomSuffix: true,
    contentType,
    ...getBlobAuthOptions(),
  });
};

/**
 * Generate a short-lived, strictly scoped client upload token for direct browser -> Vercel Blob uploads.
 * Bypasses Vercel's 4.5 MB serverless request payload limit while keeping BLOB_READ_WRITE_TOKEN strictly on the backend.
 */
export const createScopedExcelUploadToken = async (pathname: string): Promise<string> => {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error(
      'Vercel Blob Storage is not configured. Please set BLOB_READ_WRITE_TOKEN in backend .env.local or Vercel Environment Variables.'
    );
  }

  return generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    pathname,
    maximumSizeInBytes: MAX_EXCEL_FILE_SIZE_BYTES,
    allowedContentTypes: ALLOWED_EXCEL_MIME_TYPES,
    addRandomSuffix: true,
    validUntil: Date.now() + 5 * 60 * 1000, // 5 minutes expiry
  });
};

/**
 * Retrieve a private Excel file stream & metadata from Vercel Blob Private Storage using `get()`.
 */
export const getPrivateExcelBlob = async (
  urlOrPathname: string
): Promise<GetBlobResult | null> => {
  if (!isBlobStorageConfigured()) {
    throw new Error(
      'Vercel Blob Storage is not configured. Please set BLOB_READ_WRITE_TOKEN (and BLOB_STORE_ID) in backend environment variables.'
    );
  }

  return get(urlOrPathname, {
    access: 'private',
    useCache: false,
    ...getBlobAuthOptions(),
  });
};

/**
 * Read a private Vercel Blob object into a Node Buffer (used for ExcelJS processing after client upload).
 */
export const readPrivateExcelBlobToBuffer = async (urlOrPathname: string): Promise<Buffer> => {
  const result = await getPrivateExcelBlob(urlOrPathname);
  if (!result || result.statusCode !== 200 || !result.stream) {
    throw new Error('Uploaded Excel file could not be retrieved from Vercel Blob Private Storage.');
  }

  const reader = result.stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/**
 * Permanently delete a private Excel file from Vercel Blob Storage using `del()`.
 */
export const deletePrivateExcelBlob = async (urlOrPathname: string): Promise<void> => {
  if (!isBlobStorageConfigured() || !urlOrPathname) return;
  await del(urlOrPathname, getBlobAuthOptions());
};

export const MAX_PDF_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15 MB

export const isPdfFileName = (fileName: string): boolean => {
  return /\.pdf$/i.test(String(fileName || '').trim());
};

export const buildSupplierPdfBlobPathname = (supplierName: string, originalFileName: string): string => {
  const safeSupplier = String(supplierName || 'supplier').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeName = sanitizeFileName(originalFileName);
  const timestamp = Date.now();
  return `supplier-documents/${safeSupplier}/${timestamp}_${safeName}`;
};

export const uploadPrivatePdfBlob = async (
  pathname: string,
  buffer: Buffer,
  contentType = 'application/pdf'
): Promise<PutBlobResult> => {
  if (!isBlobStorageConfigured()) {
    throw new Error(
      'Vercel Blob Storage is not configured. Please set BLOB_READ_WRITE_TOKEN in backend environment variables.'
    );
  }

  return put(pathname, buffer, {
    access: 'private',
    addRandomSuffix: true,
    contentType,
    ...getBlobAuthOptions(),
  });
};

export const getPrivatePdfBlob = async (
  urlOrPathname: string
): Promise<GetBlobResult | null> => {
  if (!isBlobStorageConfigured()) {
    throw new Error(
      'Vercel Blob Storage is not configured. Please set BLOB_READ_WRITE_TOKEN in backend environment variables.'
    );
  }

  return get(urlOrPathname, {
    access: 'private',
    useCache: false,
    ...getBlobAuthOptions(),
  });
};

export const deletePrivatePdfBlob = async (urlOrPathname: string): Promise<void> => {
  if (!isBlobStorageConfigured() || !urlOrPathname) return;
  await del(urlOrPathname, getBlobAuthOptions());
};


