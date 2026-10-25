import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Task from '../../src/models/task.model.js';
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

describe('DELETE /api/tasks/:id', () => {
  it('returns 204 for an existing task', async () => {
    const task = await createTask();
    const res = await api.delete(`/api/tasks/${task._id}`);
    expect(res.status).toBe(204);
  });

  it('returns no response body on success', async () => {
    const task = await createTask();
    const res = await api.delete(`/api/tasks/${task._id}`);
    expect(res.text).toBe('');
    expect(res.body).toEqual({});
  });

  it('removes the document from MongoDB', async () => {
    const task = await createTask();
    await api.delete(`/api/tasks/${task._id}`);
    const stored = await Task.findById(task._id);
    expect(stored).toBeNull();
  });

  it('GET after delete returns 404', async () => {
    const task = await createTask();
    await api.delete(`/api/tasks/${task._id}`);
    const res = await api.get(`/api/tasks/${task._id}`);
    expect(res.status).toBe(404);
  });

  it('deleting the same id again returns 404', async () => {
    const task = await createTask();
    await api.delete(`/api/tasks/${task._id}`);
    const res = await api.delete(`/api/tasks/${task._id}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed ObjectId', async () => {
    const res = await api.delete('/api/tasks/not-a-valid-id');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a valid but nonexistent ObjectId', async () => {
    const res = await api.delete('/api/tasks/64b7f1f1f1f1f1f1f1f1f1f1');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tasks without an id returns 404 and never performs a bulk delete', async () => {
    await createTask({ title: 'Should survive' });
    await createTask({ title: 'Should also survive' });

    const res = await api.delete('/api/tasks');
    expect(res.status).toBe(404);

    expect(await Task.countDocuments()).toBe(2);
  });

  it('deleting one task does not delete other tasks', async () => {
    const target = await createTask({ title: 'Delete me' });
    const other = await createTask({ title: 'Keep me' });

    await api.delete(`/api/tasks/${target._id}`);

    expect(await Task.findById(other._id)).not.toBeNull();
    expect(await Task.countDocuments()).toBe(1);
  });

  it('matches the approved delete response contract (204, empty body, Content-Type not application/json)', async () => {
    const task = await createTask();
    const res = await api.delete(`/api/tasks/${task._id}`);
    expect(res.status).toBe(204);
    expect(res.headers['content-type']).toBeUndefined();
  });
});
