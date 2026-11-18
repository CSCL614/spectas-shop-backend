import { Router } from 'express';
import { login, me, changePassword, logout, heartbeat } from '../controllers/authController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';

const router = Router();

router.post('/login', login);
router.post('/logout', authMiddleware, logout);
router.post('/heartbeat', authMiddleware, heartbeat);
router.get('/me', authMiddleware, me);
router.post('/change-password', authMiddleware, requireAdmin, changePassword);

export default router;
