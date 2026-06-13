import { Router } from 'express';
import {
  changePassword,
  getCurrentUser,
  login,
  registerResident,
  requestPasswordResetOtp,
  requestRegistrationOtp,
  resetPasswordWithOtp,
  verifyRegistrationOtp
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadResidentId } from '../middleware/upload.js';

const router = Router();

router.post('/login', login);
router.get('/me', authenticate, getCurrentUser);
router.post('/forgot-password/request-otp', requestPasswordResetOtp);
router.post('/forgot-password/reset', resetPasswordWithOtp);
router.post('/change-password', authenticate, changePassword);
router.post('/register/request-otp', requestRegistrationOtp);
router.post('/register/verify-otp', verifyRegistrationOtp);
router.post('/register', uploadResidentId.single('selfieWithId'), registerResident);

export default router;
