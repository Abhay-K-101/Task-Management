import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';
import { buildTaskPayload } from '../setup/test-data.js';

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

afterAll(async () => {
  await disconnectTestDatabase();
});

async function createTask(overrides = {}) {
  const res = await api.post('/api/tasks').send(buildTaskPayload(overrides));
  return res.body.data;
}

describe('GET /api/tasks/:id', () => {
  it('returns 200 for an existing id', async () => {
    const task = await createTask();
    const res = await api.get(`/api/tasks/${task._id}`);
    expect(res.status).toBe(200);
  });

  it('uses success: true and a data envelope', async () => {
    const task = await createTask();
    const res = await api.get(`/api/tasks/${task._id}`);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(expect.any(Object));
  });

  it('returns the task matching the requested id', async () => {
    const task = await createTask({ title: 'Find me' });
    const res = await api.get(`/api/tasks/${task._id}`);
    expect(res.body.data._id).toBe(task._id);
    expect(res.body.data.title).toBe('Find me');
  });

  it('returns 404 for a valid but nonexistent ObjectId', async () => {
    const res = await api.get('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for a malformed ObjectId', async () => {
    const res = await api.get('/api/tasks/not-a-valid-id');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 for a previously deleted id', async () => {
    const task = await createTask();
    await api.delete(`/api/tasks/${task._id}`);
    const res = await api.get(`/api/tasks/${task._id}`);
    expect(res.status).toBe(404);
  });

  it('does not expose internal error information', async () => {
    const res = await api.get('/api/tasks/not-a-valid-id');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/at .*\.js:\d+/);
    expect(raw).not.toContain('node_modules');
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  });

  it('treats /api/tasks/ (trailing slash, no id) as the list endpoint, not an id lookup', async () => {
    await createTask();
    const res = await api.get('/api/tasks/');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination).toBeDefined();
  });
});
