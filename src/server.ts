import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { list } from '@vercel/blob';

// Load .env first, then override with .env.local for local development
dotenv.config();
const envLocalCandidates = [
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(__dirname, '..', '.env.local'),
];
for (const candidate of envLocalCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: true });
    break;
  }
}

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { connectDB } from './config/db';
import { seedPredefinedUsers, seedDummySales, migrateStickerNumbersToSTK } from './utils/seeder';

import authRoutes from './routes/authRoutes';
import salesRoutes from './routes/salesRoutes';
import excelRoutes from './routes/excelRoutes';
import adminRoutes from './routes/adminRoutes';
import userRoutes from './routes/userRoutes';
import feedbackRoutes from './routes/feedbackRoutes';
import brandRoutes from './routes/brandRoutes';

const app = express();
const PORT = process.env.PORT || 8099;

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  })
);
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health Check
app.get(['/', '/health', '/api/health'], (_req: Request, res: Response) => {
  res.json({
    status: 'UP',
    service: 'SRI SAI SMART OPTICALS SOFTWARE Backend (Node.js/Express)',
    tagline: 'A Clear Vision for Better Business',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: 'SpectaclesShopDB (MongoDB Atlas)',
  });
});

// Safe Vercel Blob Storage Configuration & Read-Only Connectivity Check
app.get('/api/health/blob', async (_req: Request, res: Response) => {
  const storeIdConfigured = Boolean(process.env.BLOB_STORE_ID && process.env.BLOB_STORE_ID.trim());
  const tokenConfigured = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_READ_WRITE_TOKEN.trim()
  );

  const missingVars: string[] = [];
  if (!storeIdConfigured) missingVars.push('BLOB_STORE_ID');
  if (!tokenConfigured) missingVars.push('BLOB_READ_WRITE_TOKEN');

  if (!tokenConfigured) {
    res.status(503).json({
      success: false,
      blobConfigured: false,
      storeIdConfigured,
      tokenConfigured,
      connectionStatus: 'not_configured',
      message: `Vercel Blob Storage is missing required environment variable(s): ${missingVars.join(', ')}.`,
    });
    return;
  }

  try {
    // Safe read-only connectivity check (does not upload, modify, or delete any files)
    await list({
      limit: 1,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const fullyConfigured = storeIdConfigured && tokenConfigured;
    res.json({
      success: fullyConfigured,
      blobConfigured: fullyConfigured,
      storeIdConfigured,
      tokenConfigured,
      connectionStatus: 'connected',
      message: fullyConfigured
        ? 'Vercel Blob Storage is configured successfully.'
        : `Connected to Vercel Blob, but missing optional/expected variable: ${missingVars.join(', ')}.`,
    });
  } catch (error: any) {
    res.status(502).json({
      success: false,
      blobConfigured: false,
      storeIdConfigured,
      tokenConfigured,
      connectionStatus: 'error',
      message: `Vercel Blob connectivity check failed: ${error?.name || 'BlobError'} - ${error?.message || 'Unable to reach Vercel Blob store'}`,
    });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/excel', excelRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/brands', brandRoutes);

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: 'Requested API endpoint not found',
    data: null,
  });
});

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Global Error]:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
    data: null,
  });
});

// App initialization helper for both standalone and serverless
let isInitialized = false;
export const initApp = async () => {
  if (!isInitialized) {
    await connectDB();
    await seedPredefinedUsers();
    await seedDummySales(false);
    await migrateStickerNumbersToSTK();
    isInitialized = true;
  }
};

// Start Server (standalone mode)
const startServer = async () => {
  try {
    await initApp();

    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(` SRI SAI SMART OPTICALS SOFTWARE Backend is running!`);
      console.log(` Tagline: A Clear Vision for Better Business`);
      console.log(` Port:    http://localhost:${PORT}`);
      console.log(` Health:  http://localhost:${PORT}/api/health`);
      console.log(` Database: MongoDB (SpectaclesShopDB)`);
      console.log(`=======================================================`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Only listen on port in standalone mode (not when imported as a Vercel serverless function)
if (!process.env.VERCEL) {
  startServer();
}

export default app;

