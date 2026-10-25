import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import app from '../../src/app.js';
import Task from '../../src/models/task.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser } from '../setup/auth.js';
import { corsMiddleware } from '../../src/middleware/cors.middleware.js';
import { createLimiter } from '../../src/middleware/rate-limit.middleware.js';

// Helmet is mounted first in src/app.js precisely so its headers survive every
// exit path — not just the happy one. These tests walk the real app through a
// success, a validation failure, an auth failure, an unknown route and an
// unexpected 500, and assert the headers are on all of them.

let authed;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  // The real app's limiters are process-wide singletons. Clearing them
  // here means no test file can inherit counters from another.
  resetRateLimiters();
  await clearTestDatabase();
  authed = await createTestUser();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

// The headers that actually matter for a JSON API, with the values Helmet's
// defaults produce. Deliberately a short list: pinning every header Helmet
// has ever shipped would make this suite fail on a harmless library update
// without protecting any approved contract.
function expectSecurityHeaders(res) {
  // Stops a browser from second-guessing Content-Type and executing a JSON
  // response as script.
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  // Clickjacking protection.
  expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  // Keeps URLs (which can carry ids) out of Referer headers sent elsewhere.
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  // Express's free version advertisement, removed.
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('security headers on every exit path', () => {
  it('200 — successful API response', async () => {
    const res = await authed.api.get('/api/tasks');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it('201 — successful write', async () => {
    const res = await authed.api.post('/api/tasks').send({ title: 'Header check' });
    expect(res.status).toBe(201);
    expectSecurityHeaders(res);
  });

  it('400 — validation failure', async () => {
    const res = await authed.api.post('/api/tasks').send({ title: 'ab' });
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });

  it('401 — authentication failure', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it('404 — unknown route', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it('404 — missing resource', async () => {
    const res = await authed.api.get('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it('500 — unexpected server error', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(new Error('simulated failure'));
    const res = await authed.api.get('/api/tasks');
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });

  it('auth endpoints carry them too', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
    expectSecurityHeaders(res);
  });
});

describe('individual headers, and what they are for', () => {
  it('sets a Content-Security-Policy', async () => {
    // Largely inert for a pure JSON API — CSP governs what a *document* may
    // load, and this API never returns HTML. It is kept because it costs
    // nothing and does protect the one case that matters: a browser somehow
    // rendering an API response directly.
    const res = await authed.api.get('/api/tasks');
    expect(res.headers['content-security-policy']).toEqual(expect.any(String));
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('sets Strict-Transport-Security', async () => {
    // Worth being precise about: HSTS is an instruction to browsers to refuse
    // plain HTTP for this host in future. It does nothing at all unless the
    // API is actually served over HTTPS — it cannot upgrade a connection by
    // itself, and over plain HTTP a browser ignores it entirely.
    const res = await authed.api.get('/api/tasks');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('does not disable protections to make responses simpler', async () => {
    const res = await authed.api.get('/api/tasks');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('headers do not replace input validation', async () => {
    // A header tells a *browser* how to behave. It has no opinion about a bad
    // request body, which is still rejected by the validators — the two
    // controls protect different things and neither substitutes for the other.
    const res = await authed.api.post('/api/tasks').send({ title: 'ab' });
    expectSecurityHeaders(res);
    expect(res.status).toBe(400);
  });
});

describe('429 responses also carry security headers', () => {
  // The real app's limits are deliberately set very high for the test run, so
  // exhausting them here is impractical. This mirrors src/app.js's exact
  // middleware ORDER (helmet -> cors -> limiter) with a limit of 1, which is
  // the property actually under test: that a request rejected by the limiter
  // has already passed through Helmet and therefore still carries its headers.
  function buildThrottledApp() {
    const miniApp = express();
    miniApp.disable('x-powered-by');
    miniApp.use(helmet());
    miniApp.use(corsMiddleware);
    miniApp.use('/api', createLimiter({ windowMs: 60_000, limit: 1 }));
    miniApp.get('/api/ping', (req, res) => res.status(200).json({ success: true }));
    return miniApp;
  }

  it('a 429 still has the security headers', async () => {
    const miniApp = buildThrottledApp();
    await request(miniApp).get('/api/ping');
    const res = await request(miniApp).get('/api/ping');

    expect(res.status).toBe(429);
    expectSecurityHeaders(res);
  });

  it('a 429 body still uses the standard envelope', async () => {
    const miniApp = buildThrottledApp();
    await request(miniApp).get('/api/ping');
    const res = await request(miniApp).get('/api/ping');

    expect(res.body).toEqual({ success: false, message: expect.any(String) });
  });
});

describe('the real app mounts the rate limiter', () => {
  it('API responses advertise a rate-limit policy', async () => {
    // Proof that the limiter is actually in the chain, independent of the
    // threshold (which the focused tests cover).
    const res = await authed.api.get('/api/tasks');
    expect(Object.keys(res.headers).join(',')).toMatch(/ratelimit/i);
  });

  it('auth endpoints advertise one as well', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(Object.keys(res.headers).join(',')).toMatch(/ratelimit/i);
  });
});
