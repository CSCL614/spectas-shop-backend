import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { connectDB } from './config/db';
import { seedPredefinedUsers, seedDummySales } from './utils/seeder';

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
    origin: '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health Check
app.get(['/', '/health', '/api/health'], (_req: Request, res: Response) => {
  res.json({
    status: 'UP',
    service: 'Spectacles Shop Management ERP Backend (Node.js/Express)',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: 'SpectaclesShopDB (MongoDB Atlas)',
  });
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
    isInitialized = true;
  }
};

// Start Server (standalone mode)
const startServer = async () => {
  try {
    await initApp();

    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(` Spectacles ERP Node.js Backend is running!`);
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

