import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import Task from '../../src/models/task.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';

// Populated in beforeEach: an authenticated request helper bound to a
// freshly created user, plus that user's id for seeding.
let api;
let ownerId;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  // A fresh authenticated user per test. clearTestDatabase() wipes the users
  // collection too, so this must run after it, not once in beforeAll.
  const auth = await createTestUser();
  api = auth.api;
  ownerId = auth.userId;
});

afterEach(() => {
  // Every spy created in this file is restored immediately after the test
  // that created it, in addition to this belt-and-suspenders sweep — no
  // mock is allowed to leak into a later test.
  vi.restoreAllMocks();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('Global error and security behaviour', () => {
  it('an unknown route returns 404', async () => {
    const res = await api.get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Route not found' });
  });

  it('an unregistered HTTP method on a known path returns the same 404 shape', async () => {
    // PUT is not registered on /api/tasks (only POST/GET are); Express
    // falls through to the 404 catch-all exactly as it does for any other
    // unmatched request.
    const res = await api.put('/api/tasks').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Route not found' });
  });

  it('malformed JSON returns 400', async () => {
    const res = await api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('a validation failure returns 400', async () => {
    const res = await api.post('/api/tasks').send({ title: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('an invalid ObjectId returns 400', async () => {
    const res = await api.get('/api/tasks/not-a-valid-id');
    expect(res.status).toBe(400);
  });

  it('a missing resource returns 404', async () => {
    const res = await api.get('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');
    expect(res.status).toBe(404);
  });

  it('an unexpected database failure returns 500', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(new Error('simulated failure'));

    const res = await api.get('/api/tasks');

    expect(res.status).toBe(500);
  });

  it('an unexpected 500 contains success:false and a generic safe message', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(new Error('simulated failure'));

    const res = await api.get('/api/tasks');

    expect(res.body).toEqual({ success: false, message: 'Something went wrong' });
  });

  it('an unexpected 500 never leaks a stack trace, connection string, host, credentials or internals — even if the underlying error contains them', async () => {
    // Deliberately craft an underlying error whose message looks like it
    // contains a leak-worthy connection string and credentials, to prove
    // the client-facing response is safe regardless of what the real
    // failure happens to say.
    const dangerousError = new Error(
      'connection lost: mongodb://admin:s3cr3t@internal-db-host:27017/production ' +
        'at Object.<anonymous> (/app/node_modules/mongodb/lib/collection.js:200:11)'
    );
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(dangerousError);

    const res = await api.get('/api/tasks');
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain('mongodb://');
    expect(raw).not.toContain('admin');
    expect(raw).not.toContain('s3cr3t');
    expect(raw).not.toContain('internal-db-host');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toMatch(/at .*:\d+:\d+/);
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  });

  it('the application remains usable after a normal 400', async () => {
    const badRequest = await api.post('/api/tasks').send({ title: 'ab' });
    expect(badRequest.status).toBe(400);

    const goodRequest = await api.post('/api/tasks').send({ title: 'Still works' });
    expect(goodRequest.status).toBe(201);
  });

  it('the application remains usable after a normal 404', async () => {
    const notFound = await api.get('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');
    expect(notFound.status).toBe(404);

    const goodRequest = await api.get('/api/tasks');
    expect(goodRequest.status).toBe(200);
  });

  it('a mocked repository failure does not leak into the next, unrelated request', async () => {
    vi.spyOn(Task, 'countDocuments').mockRejectedValueOnce(new Error('simulated failure'));
    const failing = await api.get('/api/tasks');
    expect(failing.status).toBe(500);

    // afterEach already restores the spy, but this same-test follow-up
    // request proves the mock was single-shot (mockRejectedValueOnce) and
    // the next call to the real Task.countDocuments behaves normally.
    const following = await api.get('/api/tasks');
    expect(following.status).toBe(200);
  });
});
