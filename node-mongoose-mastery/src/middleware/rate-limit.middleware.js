import { rateLimit, MemoryStore } from 'express-rate-limit';
import { getRateLimitConfig, getAuthRateLimitConfig } from '../config/security.js';

// Rate limiting caps how fast one client can hammer the API. It is a blunt
// instrument and it is honest about that: it slows brute force from
// "thousands of guesses a second" to "a handful per window", which turns an
// overnight attack into an infeasible one. It does NOT make a weak password
// safe — an attacker who guesses right on attempt three is never rate-limited.
//
// The store is in-memory. That is the correct choice for this single-process
// learning project and the wrong one for a horizontally scaled deployment:
// with N instances behind a load balancer each keeps its own counters, so the
// effective limit becomes N x limit, and a restart resets everything. Fixing
// that properly needs a shared store (Redis), which is deliberately out of
// scope for this phase.

// The 429 body is shaped exactly like every other error in this API. A client
// parsing `success` and `message` needs no special case for being throttled.
function rateLimitHandler(req, res) {
  res.status(429).json({
    success: false,
    message: 'Too many requests. Please try again later.',
  });
}

const SHARED_OPTIONS = {
  // RateLimit / RateLimit-Policy headers (the IETF draft standard) rather
  // than the older X-RateLimit-* set.
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
};

// Each limiter owns its own MemoryStore instance. Keeping explicit references
// is what lets tests reset counters between cases without reaching into the
// library's internals or waiting for a real window to elapse.
function createLimiter({ windowMs, limit, skipSuccessfulRequests = false }) {
  const store = new MemoryStore();
  const middleware = rateLimit({
    ...SHARED_OPTIONS,
    windowMs,
    limit,
    skipSuccessfulRequests,
    store,
  });
  middleware.__store = store;
  return middleware;
}

// Broad protection for the whole API surface: scraping, accidental client
// retry storms, cheap denial-of-service attempts.
function createGeneralLimiter(overrides = {}) {
  return createLimiter({ ...getRateLimitConfig(), ...overrides });
}

// Much stricter, and applied only to the endpoints where guessing is the
// attack. Failed attempts are what count here (see below).
function createAuthLimiter(overrides = {}) {
  return createLimiter({
    ...getAuthRateLimitConfig(),
    // Counting policy for LOGIN: only failed attempts consume budget.
    // Brute force is, by definition, a stream of failures, so it is throttled
    // exactly as intended — while a legitimate user who signs in correctly
    // never burns through their allowance and never locks themselves out.
    skipSuccessfulRequests: true,
    ...overrides,
  });
}

// Counting policy for REGISTER: every request counts, successful or not.
// Here the *successful* request is the abuse — automated mass account
// creation — so skipping successes would defeat the purpose.
function createRegistrationLimiter(overrides = {}) {
  return createLimiter({
    ...getAuthRateLimitConfig(),
    skipSuccessfulRequests: false,
    ...overrides,
  });
}

// Built once and mounted by app.js / auth.routes.js.
const generalLimiter = createGeneralLimiter();
const authLimiter = createAuthLimiter();
const registrationLimiter = createRegistrationLimiter();

// Clears every counter on the app's mounted limiters. Used by tests so one
// file's requests can never exhaust another file's budget; never called by
// production code.
function resetRateLimiters() {
  for (const limiter of [generalLimiter, authLimiter, registrationLimiter]) {
    limiter.__store?.resetAll?.();
  }
}

export {
  generalLimiter,
  authLimiter,
  registrationLimiter,
  createGeneralLimiter,
  createAuthLimiter,
  createRegistrationLimiter,
  createLimiter,
  resetRateLimiters,
  rateLimitHandler,
};
