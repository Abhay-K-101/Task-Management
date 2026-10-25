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

function patch(id, body) {
  return api.patch(`/api/tasks/${id}`).send(body);
}

describe('PATCH /api/tasks/:id — positive updates', () => {
  it('updates title only', async () => {
    const task = await createTask({ title: 'Old title' });
    const res = await patch(task._id, { title: 'New title' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('New title');
  });

  it('updates description only', async () => {
    const task = await createTask({ description: 'Old' });
    const res = await patch(task._id, { description: 'New' });
    expect(res.body.data.description).toBe('New');
  });

  it('updates priority only', async () => {
    const task = await createTask({ priority: 'low' });
    const res = await patch(task._id, { priority: 'high' });
    expect(res.body.data.priority).toBe('high');
  });

  it('updates status only (todo -> done, deriving completed)', async () => {
    const task = await createTask({ status: 'todo' });
    const res = await patch(task._id, { status: 'done' });
    expect(res.body.data).toMatchObject({ status: 'done', completed: true });
  });

  it('updates completed only (false -> true, deriving status)', async () => {
    const task = await createTask({ completed: false });
    const res = await patch(task._id, { completed: true });
    expect(res.body.data).toMatchObject({ completed: true, status: 'done' });
  });

  it('updates multiple allowed fields at once', async () => {
    const task = await createTask();
    const res = await patch(task._id, { title: 'Multi update', priority: 'high', description: 'Updated' });
    expect(res.body.data).toMatchObject({ title: 'Multi update', priority: 'high', description: 'Updated' });
  });

  it('leaves fields that were not supplied unchanged', async () => {
    const task = await createTask({ title: 'Keep me', description: 'Keep me too', priority: 'low' });
    const res = await patch(task._id, { priority: 'high' });
    expect(res.body.data.title).toBe('Keep me');
    expect(res.body.data.description).toBe('Keep me too');
  });

  it('changes updatedAt', async () => {
    const task = await createTask();
    const res = await patch(task._id, { title: 'Changed' });
    expect(res.body.data.updatedAt).not.toBe(task.updatedAt);
  });

  it('persists the change to the database', async () => {
    const task = await createTask({ title: 'Before' });
    await patch(task._id, { title: 'After' });
    const stored = await Task.findById(task._id);
    expect(stored.title).toBe('After');
  });

  it('returns success: true and the updated task data', async () => {
    const task = await createTask();
    const res = await patch(task._id, { title: 'Updated' });
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe('Updated');
  });
});

describe('PATCH /api/tasks/:id — validation', () => {
  it('rejects an invalid ObjectId', async () => {
    const res = await patch('not-a-valid-id', { title: 'x' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a valid but nonexistent ObjectId', async () => {
    const res = await patch('64b7f1f1f1f1f1f1f1f1f1f1', { title: 'Valid title' });
    expect(res.status).toBe(404);
  });

  it('rejects a title shorter than 3 characters', async () => {
    const task = await createTask();
    const res = await patch(task._id, { title: 'ab' });
    expect(res.status).toBe(400);
  });

  it('rejects a title longer than 100 characters', async () => {
    const task = await createTask();
    const res = await patch(task._id, { title: 'a'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('rejects a description longer than 1000 characters', async () => {
    const task = await createTask();
    const res = await patch(task._id, { description: 'd'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid priority', async () => {
    const task = await createTask();
    const res = await patch(task._id, { priority: 'urgent' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid status', async () => {
    const task = await createTask();
    const res = await patch(task._id, { status: 'archived' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid completed type', async () => {
    const task = await createTask();
    const res = await patch(task._id, { completed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('rejects a single unknown field', async () => {
    const task = await createTask();
    const res = await patch(task._id, { hackField: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('hackField');
  });

  it('rejects multiple unknown fields', async () => {
    const task = await createTask();
    const res = await patch(task._id, { hackField: true, other: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('hackField');
    expect(res.body.message).toContain('other');
  });

  it('returns 400 for malformed JSON', async () => {
    const task = await createTask();
    const res = await api
      .patch(`/api/tasks/${task._id}`)
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });

  it('an empty update body succeeds and leaves the task unchanged (documented contract)', async () => {
    const task = await createTask({ title: 'Untouched' });
    const res = await patch(task._id, {});
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Untouched');
  });

  it.each(['_id', 'createdAt', 'updatedAt'])(
    'rejects an attempt to set the internal field "%s" and does not modify the document',
    async (field) => {
      const task = await createTask();
      const res = await patch(task._id, { [field]: 'tampered' });
      expect(res.status).toBe(400);

      const stored = await Task.findById(task._id);
      expect(stored.createdAt.toISOString()).toBe(task.createdAt);
      expect(stored.updatedAt.toISOString()).toBe(task.updatedAt);
      expect(stored._id.toString()).toBe(task._id);
    }
  );
});

describe('PATCH /api/tasks/:id — invariant transitions', () => {
  it('todo -> done using status only', async () => {
    const task = await createTask({ status: 'todo' });
    const res = await patch(task._id, { status: 'done' });
    expect(res.body.data).toMatchObject({ status: 'done', completed: true });
  });

  it('in-progress -> done using status only', async () => {
    const task = await createTask({ status: 'in-progress' });
    const res = await patch(task._id, { status: 'done' });
    expect(res.body.data).toMatchObject({ status: 'done', completed: true });
  });

  it('done -> todo using status only', async () => {
    const task = await createTask({ status: 'done', completed: true });
    const res = await patch(task._id, { status: 'todo' });
    expect(res.body.data).toMatchObject({ status: 'todo', completed: false });
  });

  it('done -> in-progress using status only', async () => {
    const task = await createTask({ status: 'done', completed: true });
    const res = await patch(task._id, { status: 'in-progress' });
    expect(res.body.data).toMatchObject({ status: 'in-progress', completed: false });
  });

  it('completed: true changes status to done', async () => {
    const task = await createTask({ status: 'in-progress' });
    const res = await patch(task._id, { completed: true });
    expect(res.body.data).toMatchObject({ completed: true, status: 'done' });
  });

  it('completed: false changes an existing "done" status to "todo"', async () => {
    const task = await createTask({ status: 'done', completed: true });
    const res = await patch(task._id, { completed: false });
    expect(res.body.data).toMatchObject({ completed: false, status: 'todo' });
  });

  it('completed: false preserves an existing "in-progress" status', async () => {
    const task = await createTask({ status: 'in-progress' });
    const res = await patch(task._id, { completed: false });
    expect(res.body.data).toMatchObject({ completed: false, status: 'in-progress' });
  });

  it('status "done" with completed: true succeeds', async () => {
    const task = await createTask();
    const res = await patch(task._id, { status: 'done', completed: true });
    expect(res.status).toBe(200);
  });

  it('status "todo" with completed: false succeeds', async () => {
    const task = await createTask({ status: 'done', completed: true });
    const res = await patch(task._id, { status: 'todo', completed: false });
    expect(res.status).toBe(200);
  });

  it('status "in-progress" with completed: false succeeds', async () => {
    const task = await createTask();
    const res = await patch(task._id, { status: 'in-progress', completed: false });
    expect(res.status).toBe(200);
  });

  it('a contradictory status/completed combination returns 400', async () => {
    const task = await createTask();
    const res = await patch(task._id, { status: 'done', completed: false });
    expect(res.status).toBe(400);
  });

  it('a contradictory update produces no partial write', async () => {
    const task = await createTask({ title: 'Original', status: 'todo', completed: false });
    await patch(task._id, { title: 'Should not apply', status: 'done', completed: false });

    const stored = await Task.findById(task._id);
    expect(stored.title).toBe('Original');
    expect(stored.status).toBe('todo');
    expect(stored.completed).toBe(false);
  });

  it('a failed (validation-rejected) update leaves all original fields unchanged', async () => {
    const task = await createTask({ title: 'Original', description: 'Original desc', priority: 'low' });
    await patch(task._id, { title: 'ab' }); // too short, rejected

    const stored = await Task.findById(task._id);
    expect(stored.title).toBe('Original');
    expect(stored.description).toBe('Original desc');
    expect(stored.priority).toBe('low');
  });
});
