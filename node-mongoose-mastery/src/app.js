import express from 'express';
import helmet from 'helmet';
import taskRoutes from './routes/task.routes.js';
import authRoutes from './routes/auth.routes.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';
import { corsMiddleware } from './middleware/cors.middleware.js';
import { generalLimiter } from './middleware/rate-limit.middleware.js';
import { getJsonBodyLimitBytes } from './config/security.js';

const app = express();

// ---------------------------------------------------------------------------
// Middleware order is a security decision, not a stylistic one.
// Each layer below is placed where it is for a specific reason.
// ---------------------------------------------------------------------------

// Express advertises itself with `X-Powered-By: Express` by default. Removing
// it is not a real defence — anyone can fingerprint a server other ways — but
// there is no reason to hand a scanner a free version hint. Helmet also does
// this; doing it explicitly means the guarantee survives a Helmet config
// change.
app.disable('x-powered-by');

// `trust proxy` is deliberately left at its default (disabled).
//
// When disabled, req.ip is the address of whatever actually opened the TCP
// connection, which is the truth for direct execution — how this project runs.
// Enabling it tells Express to believe the X-Forwarded-For header instead, and
// that is only safe when a proxy you control is guaranteed to overwrite that
// header. Enabling it without such a proxy lets any client spoof its own IP
// and therefore dodge the rate limiter entirely; setting it wrongly behind a
// proxy can instead collapse every client onto one shared identity, so a
// single noisy user throttles everyone. Since this project has no reverse
// proxy, the safe answer is to change nothing and document why.

// 1. Security headers first, so they appear on *every* response — including
//    CORS rejections, rate-limit 429s, 404s and unexpected 500s.
app.use(helmet());

// 2. CORS next. Preflight OPTIONS requests are answered here and never reach
//    the router, so they must already carry the security headers from step 1.
app.use(corsMiddleware);

// 3. Rate limiting before body parsing. A throttled request should be rejected
//    before the server spends memory and CPU parsing a payload it is going to
//    discard anyway.
app.use('/api', generalLimiter);

// 4. Bounded body parsing. The limit is validated at startup and passed as a
//    byte count, so a malformed JSON_BODY_LIMIT fails loudly rather than
//    silently becoming "unlimited".
app.use(express.json({ limit: getJsonBodyLimitBytes() }));

// 5. Routes. Authentication and per-route validation live inside these.
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);

// 6. Anything unmatched.
app.use(notFoundHandler);

// 7. One place that turns any thrown error into a safe response.
app.use(errorHandler);

export default app;
