import type { Request, Response } from 'express';
import app, { initApp } from '../src/server';

export default async function handler(req: Request, res: Response) {
  try {
    await initApp();
    return app(req, res);
  } catch (err: any) {
    console.error('Vercel serverless invocation error:', err);
    res.status(500).json({
      success: false,
      message: 'Backend serverless function error: ' + (err.message || 'Unknown error'),
    });
  }
}
