import { Router } from 'express';
import { getAllBrands, createBrand } from '../controllers/brandController';
import { authMiddleware } from '../middlewares/auth';

const router = Router();

router.use(authMiddleware);

router.get('/', getAllBrands);
router.post('/', createBrand);

export default router;

