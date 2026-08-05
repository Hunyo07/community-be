// Auth routes: login, current user, password reset, change password, and resident registration.
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

// Sign in with email and password.
router.post('/login', login);
// Return the user encoded in the JWT (requires login).
router.get('/me', authenticate, getCurrentUser);
// Start forgot-password flow by emailing an OTP.
router.post('/forgot-password/request-otp', requestPasswordResetOtp);
// Finish forgot-password with OTP + new password.
router.post('/forgot-password/reset', resetPasswordWithOtp);
// Change password while already logged in.
router.post('/change-password', authenticate, changePassword);
// Resident registration: request email OTP, verify it, then submit form + selfie.
router.post('/register/request-otp', requestRegistrationOtp);
router.post('/register/verify-otp', verifyRegistrationOtp);
router.post('/register', uploadResidentId.single('selfieWithId'), registerResident);

export default router;
