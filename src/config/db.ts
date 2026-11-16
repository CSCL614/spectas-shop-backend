import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongod: MongoMemoryServer | null = null;

export const connectDB = async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/SpectaclesShopDB';

  // 1. Try configured MongoDB first (with 2-second timeout)
  try {
    const conn = await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 2000,
    });
    console.log(`[MongoDB] Connected successfully to host: ${conn.connection.host}, database: ${conn.connection.name}`);
    return;
  } catch (error: any) {
    console.warn(`[MongoDB] Local/remote MongoDB is not reachable on ${uri}`);
    console.log('[MongoDB] Starting embedded MongoDB server automatically so the ERP can run immediately...');
  }

  // 2. Seamless In-Memory fallback
  try {
    mongod = await MongoMemoryServer.create({
      binary: { version: '6.0.14' },
      instance: { dbName: 'SpectaclesShopDB' },
    });
    const memoryUri = mongod.getUri();
    const conn = await mongoose.connect(memoryUri);
    console.log(`[MongoDB] Connected successfully to Embedded In-Memory MongoDB: ${memoryUri}`);
  } catch (memoryError) {
    console.error('[MongoDB] Failed to start embedded MongoDB:', memoryError);
    process.exit(1);
  }
};

// Graceful cleanup
const cleanUp = async () => {
  if (mongod) {
    await mongod.stop();
  }
  process.exit(0);
};

process.on('SIGINT', cleanUp);
process.on('SIGTERM', cleanUp);


