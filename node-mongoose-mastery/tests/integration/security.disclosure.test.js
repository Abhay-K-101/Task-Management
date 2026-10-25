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
import { createTestUser, TEST_PASSWORD } from '../setup/auth.js';
import { createLimiter } from '../../src/middleware/rate-limit.middleware.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';

// One sweep across every status code this API can produce, asserting that none
// of them hands back anything an attacker could use: stack traces, file paths,
// connection strings, secrets, hashes or raw request content.

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

// Substrings that must never appear in any client-facing response body.
const FORBIDDEN_PATTERNS = [
  [/at .*:\d+:\d+/, 'a stack frame'],
  [/node_modules/, 'a dependency path'],
  [/\/Users\/|\/home\/|[A-Z]:\\\\/, 'a filesystem path'],
  [/mongodb(\+srv)?:\/\//, 'a MongoDB connection string'],
  [/\$2[aby]\$\d{2}\$/, 'a bcrypt hash'],
  [/passwordHash/, 'the password-hash field name'],
  [/JWT_SECRET|RATE_LIMIT_|JSON_BODY_LIMIT|ALLOWED_ORIGINS/, 'a configuration variable'],
  [/MongoServerError|CastError|ValidatorError|TypeError|ReferenceError/, 'an internal exception name'],
  [/entity\.(too\.large|parse\.failed)/, 'a body-parser internal code'],
];

function expectNoDisclosure(res) {
  const raw = JSON.stringify(res.body);
  for (const [pattern, description] of FORBIDDEN_PATTERNS) {
    expect(raw, `response disclosed ${description}: ${raw}`).not.toMatch(pattern);
  }
  // Every error body is exactly two keys, nothing more.
  if (res.body && res.body.success === false) {
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  }
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('400 — validation failures', () => {
  it('a bad task body discloses nothing', async () => {
    const res = await authed.api.post('/api/tasks').send({ title: 'ab', priority: 'urgent' });
    expect(res.status).toBe(400);
    expectNoDisclosure(res);
  });

  it('malformed JSON discloses neither the raw body nor the parser', async () => {
    const res = await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{"title": "CANARYVALUE" broken');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('CANARYVALUE');
    expectNoDisclosure(res);
  });

  it('an invalid query parameter discloses nothing', async () => {
    const res = await authed.api.get('/api/tasks?page=notanumber');
    expect(res.status).toBe(400);
    expectNoDisclosure(res);
  });

  it('a rejected registration never reflects the submitted password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'ab', email: 'bad', password: 'CANARYPASSWORD' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('CANARYPASSWORD');
    expectNoDisclosure(res);
  });
});

describe('401 — authentication failures', () => {
  it('a missing token discloses nothing', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
    expectNoDisclosure(res);
  });

  it('a bad token discloses neither the token nor the secret', async () => {
    const res = await request(app).get('/api/tasks').set('Authorization', 'Bearer CANARYTOKEN');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('CANARYTOKEN');
    expectNoDisclosure(res);
  });

  it('a wrong password never reveals whether the account exists', async () => {
    const real = await request(app)
      .post('/api/auth/login')
      .send({ email: authed.email, password: 'wrong-password' });
    const fake = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'wrong-password' });

    expect(real.status).toBe(fake.status);
    expect(real.body).toEqual(fake.body);
    expectNoDisclosure(real);
  });

  it('a successful login response contains no hash', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: authed.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expectNoDisclosure(res);
  });
});

describe('404 — not found', () => {
  it('an unknown route discloses no routing internals', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expectNoDisclosure(res);
  });

  it("another user's task is indistinguishable from a missing one", async () => {
    const other = await createTestUser();
    const theirs = await other.api.post('/api/tasks').send({ title: 'Private task' });

    const crossUser = await authed.api.get(`/api/tasks/${theirs.body.data._id}`);
    const missing = await authed.api.get('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');

    expect(crossUser.status).toBe(404);
    expect(crossUser.body).toEqual(missing.body);
    expect(JSON.stringify(crossUser.body)).not.toContain(other.id);
    expectNoDisclosure(crossUser);
  });
});

describe('413 — payload too large', () => {
  it('discloses neither the body nor the configured limit', async () => {
    const res = await authed.api
      .post('/api/tasks')
      .send({ title: 'Too big', description: 'CANARY'.repeat(5000) });

    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).not.toContain('CANARY');
    expectNoDisclosure(res);
  });
});

describe('429 — rate limited', () => {
  it('discloses no counters or configuration', async () => {
    // Mirrors src/app.js's chain so the assertions below hold against the
    // same header configuration the real app uses.
    const miniApp = express();
    miniApp.disable('x-powered-by');
    miniApp.use(helmet());
    miniApp.use('/api', createLimiter({ windowMs: 60_000, limit: 1 }));
    miniApp.get('/api/ping', (req, res) => res.status(200).json({ success: true }));
    miniApp.use(errorHandler);

    await request(miniApp).get('/api/ping');
    const res = await request(miniApp).get('/api/ping');

    expect(res.status).toBe(429);
    expectNoDisclosure(res);
  });
});

describe('500 — unexpected failures', () => {
  it('a database error becomes a generic message', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(new Error('simulated failure'));
    const res = await authed.api.get('/api/tasks');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'Something went wrong' });
    expectNoDisclosure(res);
  });

  it('an error carrying a connection string still discloses nothing', async () => {
    // Deliberately dangerous underlying error, to prove the handler's output
    // does not depend on how careless the thrown error happens to be.
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(
      new Error(
        'connection lost: mongodb://admin:hunter2@db-host:27017/prod at Object.<anonymous> (/app/node_modules/mongodb/lib/x.js:1:1)'
      )
    );
    const res = await authed.api.get('/api/tasks');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(JSON.stringify(res.body)).not.toContain('db-host');
    expectNoDisclosure(res);
  });

  it('an error carrying a bcrypt hash still discloses nothing', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(
      new Error('failed for user with hash $2b$12$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')
    );
    const res = await authed.api.get('/api/tasks');

    expect(res.status).toBe(500);
    expectNoDisclosure(res);
  });
});

describe('successful responses', () => {
  it('a task list discloses no internal fields', async () => {
    await authed.api.post('/api/tasks').send({ title: 'Ordinary task' });
    const res = await authed.api.get('/api/tasks');

    expect(res.status).toBe(200);
    expectNoDisclosure(res);
  });

  it('the current-user endpoint discloses no credentials', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.status).toBe(200);
    expectNoDisclosure(res);
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });
});
