import { Router } from 'express';
import authController from '../controllers/auth.controller.js';
import { validateRegister, validateLogin } from '../middleware/auth-validation.middleware.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter, registrationLimiter } from '../middleware/rate-limit.middleware.js';

const router = Router();

// Public: these are how a caller obtains credentials in the first place —
// which is exactly why they need a stricter limit than the rest of the API.
// The limiter runs before validation so that a flood of junk requests is
// rejected as cheaply as possible.
//
// Counting policies differ between the two on purpose:
//   register - every request counts, because a *successful* registration is
//              itself the abuse (automated mass account creation).
//   login    - only failed attempts count, because brute force is a stream of
//              failures, while a legitimate user signing in correctly should
//              never exhaust their own allowance.
router.post('/register', registrationLimiter, validateRegister, authController.register);
router.post('/login', authLimiter, validateLogin, authController.login);

// Protected: auth middleware runs first, exactly as on the task routes.
router.get('/me', requireAuth, authController.me);

export default router;
