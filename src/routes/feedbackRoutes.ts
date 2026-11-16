import { Router } from 'express';
import {
  createFeedback,
  getAllFeedback,
  deleteFeedback,
  getFeedbackStats,
} from '../controllers/feedbackController';
import { authMiddleware, requireAdmin } from '../middlewares/auth';

const router = Router();

router.use(authMiddleware);

router.get('/', getAllFeedback);
router.post('/', createFeedback);
router.get('/stats', getFeedbackStats);
router.delete('/:id', requireAdmin, deleteFeedback);

export default router;

