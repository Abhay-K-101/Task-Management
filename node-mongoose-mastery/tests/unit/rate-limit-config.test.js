import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createGeneralLimiter,
  createAuthLimiter,
  createRegistrationLimiter,
  createLimiter,
  rateLimitHandler,
} from '../../src/middleware/rate-limit.middleware.js';

// Threshold behaviour is proven here against purpose-built mini-apps, using
// the same factories the real app uses but with small explicit limits. That
// keeps these assertions deterministic and completely independent of whatever
// RATE_LIMIT_MAX happens to be configured to — a focused limiter test must
// never be ambiguous because some broader limit changed.
//
// No sleeps and no real time: every case either stays inside one window or
// clears the store explicitly.

function buildApp(limiter) {
  const app = express();
  app.use('/api', limiter);
  app.get('/api/ping', (req, res) => res.status(200).json({ success: true }));
  app.post('/api/ping', (req, res) => res.status(200).json({ success: true }));
  app.get('/api/fail', (req, res) => res.status(401).json({ success: false, message: 'nope' }));
  return app;
}

let savedEnv;
const KEYS = ['RATE_LIMIT_MAX', 'RATE_LIMIT_WINDOW_MS', 'AUTH_RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_WINDOW_MS'];

beforeEach(() => {
  savedEnv = {};
  for (const k of KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('limiter threshold behaviour', () => {
  it('allows requests up to the limit', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 3 }));
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200);
    }
  });

  it('returns 429 on the request after the limit', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 3 }));
    for (let i = 0; i < 3; i++) await request(app).get('/api/ping');
    expect((await request(app).get('/api/ping')).status).toBe(429);
  });

  it('is deterministic: the Nth+1 request is the first to be blocked', async () => {
    const limit = 5;
    const app = buildApp(createLimiter({ windowMs: 60_000, limit }));
    const statuses = [];
    for (let i = 0; i < limit + 2; i++) {
      statuses.push((await request(app).get('/api/ping')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it('keeps blocking once the limit is exceeded', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    await request(app).get('/api/ping');
    expect((await request(app).get('/api/ping')).status).toBe(429);
    expect((await request(app).get('/api/ping')).status).toBe(429);
  });
});

describe('429 response shape', () => {
  it('uses the standard error envelope', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    await request(app).get('/api/ping');
    const res = await request(app).get('/api/ping');

    expect(res.body).toEqual({ success: false, message: expect.any(String) });
    expect(res.body.success).toBe(false);
  });

  it('returns JSON, not the library default plain text', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    await request(app).get('/api/ping');
    const res = await request(app).get('/api/ping');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not leak internal counters or configuration into the body', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    await request(app).get('/api/ping');
    const res = await request(app).get('/api/ping');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/windowMs|resetTime|hits|limit":/i);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  });

  it('rateLimitHandler alone produces the documented envelope', () => {
    let status;
    let body;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { body = payload; return this; },
    };
    rateLimitHandler({}, res);
    expect(status).toBe(429);
    expect(body).toEqual({ success: false, message: expect.any(String) });
  });
});

describe('standard rate-limit headers', () => {
  it('sends draft-standard RateLimit headers on an allowed request', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 3 }));
    const res = await request(app).get('/api/ping');
    const headerNames = Object.keys(res.headers).join(',');
    expect(headerNames).toMatch(/ratelimit/i);
  });

  it('sends them on a blocked request too', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    await request(app).get('/api/ping');
    const res = await request(app).get('/api/ping');
    expect(Object.keys(res.headers).join(',')).toMatch(/ratelimit/i);
  });

  it('does not send the legacy X-RateLimit-* headers', async () => {
    const app = buildApp(createLimiter({ windowMs: 60_000, limit: 3 }));
    const res = await request(app).get('/api/ping');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});

describe('store isolation and reset', () => {
  it('two limiter instances keep independent counters', async () => {
    // This is what stops one test file exhausting another file's budget.
    const a = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));
    const b = buildApp(createLimiter({ windowMs: 60_000, limit: 1 }));

    await request(a).get('/api/ping');
    expect((await request(a).get('/api/ping')).status).toBe(429);
    expect((await request(b).get('/api/ping')).status).toBe(200);
  });

  it('resetting the store clears the counter without waiting for the window', async () => {
    // Window expiry is exactly this: the stored hits for a key stop counting.
    // Asserting it through an explicit reset keeps the test deterministic
    // instead of sleeping for a real window to elapse.
    const limiter = createLimiter({ windowMs: 60_000, limit: 1 });
    const app = buildApp(limiter);

    await request(app).get('/api/ping');
    expect((await request(app).get('/api/ping')).status).toBe(429);

    limiter.__store.resetAll();

    expect((await request(app).get('/api/ping')).status).toBe(200);
  });
});

describe('counting policy', () => {
  it('the login limiter does not count successful requests', async () => {
    // Documented policy: brute force is a stream of failures, so failures are
    // what consume budget. A user who signs in correctly never locks themselves
    // out by logging in repeatedly.
    const app = buildApp(createAuthLimiter({ windowMs: 60_000, limit: 2 }));
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200);
    }
  });

  it('the login limiter does count failed requests', async () => {
    const app = buildApp(createAuthLimiter({ windowMs: 60_000, limit: 2 }));
    expect((await request(app).get('/api/fail')).status).toBe(401);
    expect((await request(app).get('/api/fail')).status).toBe(401);
    expect((await request(app).get('/api/fail')).status).toBe(429);
  });

  it('the registration limiter counts every request, including successes', async () => {
    // Here the successful request IS the abuse: automated mass account creation.
    const app = buildApp(createRegistrationLimiter({ windowMs: 60_000, limit: 2 }));
    expect((await request(app).post('/api/ping')).status).toBe(200);
    expect((await request(app).post('/api/ping')).status).toBe(200);
    expect((await request(app).post('/api/ping')).status).toBe(429);
  });

  it('the general limiter counts every request', async () => {
    const app = buildApp(createGeneralLimiter({ windowMs: 60_000, limit: 2 }));
    expect((await request(app).get('/api/ping')).status).toBe(200);
    expect((await request(app).get('/api/ping')).status).toBe(200);
    expect((await request(app).get('/api/ping')).status).toBe(429);
  });
});

describe('factories read configuration', () => {
  it('createGeneralLimiter picks up RATE_LIMIT_MAX', async () => {
    process.env.RATE_LIMIT_MAX = '2';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    const app = buildApp(createGeneralLimiter());
    await request(app).get('/api/ping');
    await request(app).get('/api/ping');
    expect((await request(app).get('/api/ping')).status).toBe(429);
  });

  it('an explicit override beats the environment', async () => {
    process.env.RATE_LIMIT_MAX = '1';
    const app = buildApp(createGeneralLimiter({ limit: 4, windowMs: 60_000 }));
    for (let i = 0; i < 4; i++) {
      expect((await request(app).get('/api/ping')).status).toBe(200);
    }
    expect((await request(app).get('/api/ping')).status).toBe(429);
  });
});
