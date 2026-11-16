import { Router } from 'express';
import { getSalespersons } from '../controllers/userController';
import { authMiddleware } from '../middlewares/auth';

const router = Router();

router.use(authMiddleware);

router.get('/salespersons', getSalespersons);

export default router;

