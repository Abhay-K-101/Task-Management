import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import authController from '../../src/controllers/auth.controller.js';
import { validateLogin, validateRegister } from '../../src/middleware/auth-validation.middleware.js';
import { requireAuth } from '../../src/middleware/auth.middleware.js';
import taskController from '../../src/controllers/task.controller.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import {
  createAuthLimiter,
  createRegistrationLimiter,
  createGeneralLimiter,
} from '../../src/middleware/rate-limit.middleware.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser, buildRegisterPayload, TEST_PASSWORD } from '../setup/auth.js';
import {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
} from '../../src/config/security.js';

// The real app's limits are set very high for the test run so that ~1,500
// suite requests never trip a shared per-IP counter. Threshold behaviour is
// therefore proven here against apps built from the REAL controllers,
// validators and limiter factories, with small explicit limits. Same code
// path, same database, deterministic numbers — and no dependence on whatever
// the ambient configuration happens to be.

const AUTH_LIMIT = 3;

function buildAuthApp() {
  const miniApp = express();
  miniApp.use(express.json());
  miniApp.post(
    '/api/auth/login',
    createAuthLimiter({ windowMs: 60_000, limit: AUTH_LIMIT }),
    validateLogin,
    authController.login
  );
  miniApp.post(
    '/api/auth/register',
    createRegistrationLimiter({ windowMs: 60_000, limit: AUTH_LIMIT }),
    validateRegister,
    authController.register
  );
  // A protected task route sharing the app but NOT the auth limiter, to prove
  // throttling the login endpoint does not throttle everything else.
  miniApp.get('/api/tasks', requireAuth, taskController.listTasks);
  miniApp.use(errorHandler);
  return miniApp;
}

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

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('login is limited more strictly than general API use', () => {
  it('the configured login default is stricter than the general default', () => {
    expect(DEFAULT_AUTH_RATE_LIMIT_MAX).toBeLessThan(DEFAULT_RATE_LIMIT_MAX);
  });

  it('repeated wrong-password attempts eventually return 429', async () => {
    const miniApp = buildAuthApp();
    const credentials = { email: authed.email, password: 'definitely-wrong-password' };

    for (let i = 0; i < AUTH_LIMIT; i++) {
      expect((await request(miniApp).post('/api/auth/login').send(credentials)).status).toBe(401);
    }
    expect((await request(miniApp).post('/api/auth/login').send(credentials)).status).toBe(429);
  });

  it('repeated unknown-email attempts behave identically', async () => {
    const miniApp = buildAuthApp();
    const credentials = { email: 'no-such-account@example.com', password: 'whatever-password' };

    for (let i = 0; i < AUTH_LIMIT; i++) {
      expect((await request(miniApp).post('/api/auth/login').send(credentials)).status).toBe(401);
    }
    expect((await request(miniApp).post('/api/auth/login').send(credentials)).status).toBe(429);
  });

  it('throttling reveals nothing about whether an account exists', async () => {
    // The Phase 5 guarantee must survive Phase 6: a real account and an
    // imaginary one must be indistinguishable, throttled or not.
    const realApp = buildAuthApp();
    const fakeApp = buildAuthApp();

    const realResponses = [];
    const fakeResponses = [];
    for (let i = 0; i < AUTH_LIMIT + 1; i++) {
      realResponses.push(
        await request(realApp).post('/api/auth/login').send({ email: authed.email, password: 'wrong-password' })
      );
      fakeResponses.push(
        await request(fakeApp).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password' })
      );
    }

    expect(realResponses.map((r) => r.status)).toEqual(fakeResponses.map((r) => r.status));
    expect(realResponses.at(-1).body).toEqual(fakeResponses.at(-1).body);
    expect(realResponses.at(0).body).toEqual(fakeResponses.at(0).body);
  });

  it('the 429 body uses the standard envelope and leaks nothing', async () => {
    const miniApp = buildAuthApp();
    const credentials = { email: authed.email, password: 'wrong-password' };
    for (let i = 0; i < AUTH_LIMIT; i++) await request(miniApp).post('/api/auth/login').send(credentials);

    const res = await request(miniApp).post('/api/auth/login').send(credentials);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, message: expect.any(String) });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(authed.email);
    expect(raw).not.toMatch(/exist|account|user/i);
  });
});

describe('login counting policy: only failures consume budget', () => {
  it('successful logins do not exhaust the allowance', async () => {
    const miniApp = buildAuthApp();
    const good = { email: authed.email, password: TEST_PASSWORD };

    for (let i = 0; i < AUTH_LIMIT + 3; i++) {
      expect((await request(miniApp).post('/api/auth/login').send(good)).status).toBe(200);
    }
  });

  it('a legitimate user can still log in after someone else burns failures', async () => {
    // Failures still count, so brute force is throttled — but the successful
    // path is not collateral damage.
    const miniApp = buildAuthApp();
    const bad = { email: authed.email, password: 'wrong-password' };

    for (let i = 0; i < AUTH_LIMIT - 1; i++) await request(miniApp).post('/api/auth/login').send(bad);

    const res = await request(miniApp)
      .post('/api/auth/login')
      .send({ email: authed.email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('registration counting policy: every request counts', () => {
  it('successful registrations consume budget, because mass signup is the abuse', async () => {
    const miniApp = buildAuthApp();

    for (let i = 0; i < AUTH_LIMIT; i++) {
      expect((await request(miniApp).post('/api/auth/register').send(buildRegisterPayload())).status).toBe(201);
    }
    const res = await request(miniApp).post('/api/auth/register').send(buildRegisterPayload());

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, message: expect.any(String) });
  });

  it('a throttled registration creates no account', async () => {
    const miniApp = buildAuthApp();
    for (let i = 0; i < AUTH_LIMIT; i++) {
      await request(miniApp).post('/api/auth/register').send(buildRegisterPayload());
    }
    const before = await User.countDocuments();

    await request(miniApp).post('/api/auth/register').send(buildRegisterPayload());

    expect(await User.countDocuments()).toBe(before);
  });
});

describe('the auth limiter does not affect unrelated endpoints', () => {
  it('an exhausted login limiter leaves protected task routes working', async () => {
    const miniApp = buildAuthApp();
    const bad = { email: authed.email, password: 'wrong-password' };

    for (let i = 0; i < AUTH_LIMIT + 1; i++) await request(miniApp).post('/api/auth/login').send(bad);
    expect((await request(miniApp).post('/api/auth/login').send(bad)).status).toBe(429);

    const tasks = await request(miniApp)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${authed.token}`);
    expect(tasks.status).toBe(200);
  });

  it('registration and login keep separate budgets', async () => {
    const miniApp = buildAuthApp();
    const bad = { email: authed.email, password: 'wrong-password' };

    for (let i = 0; i < AUTH_LIMIT + 1; i++) await request(miniApp).post('/api/auth/login').send(bad);

    expect((await request(miniApp).post('/api/auth/register').send(buildRegisterPayload())).status).toBe(201);
  });
});

describe('the general limiter', () => {
  it('blocks once its own threshold is crossed', async () => {
    const miniApp = express();
    miniApp.use('/api', createGeneralLimiter({ windowMs: 60_000, limit: 2 }));
    miniApp.get('/api/tasks', (req, res) => res.status(200).json({ success: true }));

    expect((await request(miniApp).get('/api/tasks')).status).toBe(200);
    expect((await request(miniApp).get('/api/tasks')).status).toBe(200);
    expect((await request(miniApp).get('/api/tasks')).status).toBe(429);
  });

  it('is mounted on the real app', async () => {
    const res = await authed.api.get('/api/tasks');
    expect(Object.keys(res.headers).join(',')).toMatch(/ratelimit/i);
  });

  it('is mounted on the real auth endpoints', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x' });
    expect(Object.keys(res.headers).join(',')).toMatch(/ratelimit/i);
  });

  it('does not throttle ordinary suite traffic at the configured test ceiling', async () => {
    // Guards the arrangement itself: if the test ceiling were ever lowered to
    // something the suite can reach, unrelated files would start failing with
    // spurious 429s and this test would catch it first.
    for (let i = 0; i < 25; i++) {
      expect((await authed.api.get('/api/tasks')).status).toBe(200);
    }
  });
});
