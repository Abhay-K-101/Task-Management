import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import app from '../../src/app.js';
import Task from '../../src/models/task.model.js';
import User from '../../src/models/user.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser, buildRegisterPayload } from '../setup/auth.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import { DEFAULT_JSON_BODY_LIMIT_BYTES, parseByteSize } from '../../src/config/security.js';

// The configured limit is 16 KB, so "oversized" here is ~24 KB — large enough
// to cross the boundary, small enough that these tests allocate a trivial
// amount of memory. Nothing in this file builds a multi-megabyte string.

const LIMIT = DEFAULT_JSON_BODY_LIMIT_BYTES;

// A JSON body of roughly `bytes` total size, built from one long string field.
function bodyOfApproxSize(bytes) {
  const overhead = 40;
  return { title: 'Size probe task', description: 'x'.repeat(Math.max(bytes - overhead, 1)) };
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

describe('bodies within the limit', () => {
  it('an ordinary task body succeeds', async () => {
    const res = await authed.api.post('/api/tasks').send({ title: 'Perfectly normal task' });
    expect(res.status).toBe(201);
  });

  it('a body just under the limit is parsed (not rejected as too large)', async () => {
    // It may still fail *validation* — a 15 KB description exceeds the 1000
    // character rule — but that is a 400 from the validator, which proves the
    // parser accepted the payload rather than refusing it on size.
    const res = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT - 1024));
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(400);
  });

  it('a full-size valid task (max title and description) is comfortably allowed', async () => {
    const res = await authed.api.post('/api/tasks').send({
      title: 'a'.repeat(100),
      description: 'd'.repeat(1000),
    });
    expect(res.status).toBe(201);
  });

  it('a normal registration body succeeds', async () => {
    const res = await request(app).post('/api/auth/register').send(buildRegisterPayload());
    expect(res.status).toBe(201);
  });
});

describe('bodies over the limit', () => {
  it('returns 413 for an oversized task body', async () => {
    const res = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));
    expect(res.status).toBe(413);
  });

  it('uses the standard JSON error envelope', async () => {
    const res = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));
    expect(res.body).toEqual({ success: false, message: expect.any(String) });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('never echoes the submitted body back', async () => {
    const res = await authed.api
      .post('/api/tasks')
      .send({ title: 'Leak canary', description: 'SECRETMARKER'.repeat(2500) });

    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).not.toContain('SECRETMARKER');
  });

  it('never exposes parser internals, limits or stack traces', async () => {
    const res = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));
    const raw = JSON.stringify(res.body);

    expect(raw).not.toMatch(/entity\.too\.large/i);
    expect(raw).not.toMatch(/body-?parser|raw-body/i);
    expect(raw).not.toMatch(/node_modules/);
    expect(raw).not.toMatch(/at .*:\d+:\d+/);
    // The configured limit is not disclosed: telling a caller the exact
    // ceiling just tells an abuser how large a payload to send to stay under it.
    expect(raw).not.toContain(String(LIMIT));
  });

  it('writes nothing to the database', async () => {
    await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));
    expect(await Task.countDocuments()).toBe(0);
  });

  it('applies to registration as well', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...buildRegisterPayload(), name: 'n'.repeat(LIMIT) });

    expect(res.status).toBe(413);
    expect(await User.countDocuments()).toBe(1); // only the beforeEach user
  });

  it('applies to login as well', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@example.com', password: 'p'.repeat(LIMIT) });

    expect(res.status).toBe(413);
  });

  it('applies to updates as well', async () => {
    const created = await authed.api.post('/api/tasks').send({ title: 'Update me' });
    const res = await authed.api
      .patch(`/api/tasks/${created.body.data._id}`)
      .send(bodyOfApproxSize(LIMIT * 1.5));

    expect(res.status).toBe(413);
    expect((await Task.findById(created.body.data._id)).title).toBe('Update me');
  });
});

describe('413 and 400 are kept distinct', () => {
  it('malformed JSON is still 400, not 413', async () => {
    const res = await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });

  it('oversized-but-valid JSON is 413, not 400', async () => {
    const res = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));
    expect(res.status).toBe(413);
    expect(res.body.message).not.toMatch(/malformed/i);
  });

  it('the two failures report different messages', async () => {
    const malformed = await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{broken');
    const oversized = await authed.api.post('/api/tasks').send(bodyOfApproxSize(LIMIT * 1.5));

    expect(malformed.body.message).not.toBe(oversized.body.message);
  });
});

describe('the limit is enforced by configuration, not by accident', () => {
  it('the configured default is a deliberate, small value', () => {
    expect(LIMIT).toBe(16 * 1024);
  });

  it('a custom limit is honoured by the parser', async () => {
    // Built here rather than by re-importing the app, so the real app's
    // configuration is left untouched for every other test in the run.
    const miniApp = express();
    miniApp.use(express.json({ limit: parseByteSize('1kb', 'TEST_LIMIT') }));
    miniApp.post('/echo', (req, res) => res.status(200).json({ success: true }));
    miniApp.use(errorHandler);

    const small = await request(miniApp).post('/echo').send({ a: 'x'.repeat(100) });
    const large = await request(miniApp).post('/echo').send({ a: 'x'.repeat(4000) });

    expect(small.status).toBe(200);
    expect(large.status).toBe(413);
    expect(large.body).toEqual({ success: false, message: expect.any(String) });
  });
});
