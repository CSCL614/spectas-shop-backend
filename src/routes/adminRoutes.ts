import { Router } from 'express';
import {
  getUsers,
  getSalespersons,
  createUser,
  updateUser,
  deleteUser,
  adminResetPassword,
  toggleStatus,
  getAuditLogs,
} from '../controllers/adminController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

router.get('/users', getUsers);
router.post('/users', createUser);
router.get('/users/salespersons', getSalespersons);
router.get('/salespersons', getSalespersons);
router.put('/users/:id', updateUser);
router.delete('/users/:id', deleteUser);
router.post('/users/:id/reset-password', adminResetPassword);
router.patch('/users/:id/toggle-status', toggleStatus);
router.patch('/users/:id/status', toggleStatus);
router.get('/audit-logs', getAuditLogs);

export default router;

