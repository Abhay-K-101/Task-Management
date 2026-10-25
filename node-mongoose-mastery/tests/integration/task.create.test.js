import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Task from '../../src/models/task.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';

// `api` drives the real Express app in-process — no port, no
// server.js, no real MongoDB. See docs/phase-04-automated-testing.md
// section 4 for why this works.

function post(body) {
  return api.post('/api/tasks').send(body);
}

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

describe('POST /api/tasks — positive cases', () => {
  it('creates a task using only the required title', async () => {
    const res = await post({ title: 'Buy milk' });
    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe('Buy milk');
  });

  it('creates a task with every allowed field', async () => {
    const res = await post({
      title: 'Ship release',
      description: 'Final QA pass',
      priority: 'high',
      status: 'in-progress',
      completed: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      title: 'Ship release',
      description: 'Final QA pass',
      priority: 'high',
      status: 'in-progress',
      completed: false,
    });
  });

  it('defaults description, priority, status and completed when omitted', async () => {
    const res = await post({ title: 'Minimal task' });
    expect(res.body.data).toMatchObject({
      description: '',
      priority: 'medium',
      status: 'todo',
      completed: false,
    });
  });

  it('trims leading/trailing whitespace from title and description', async () => {
    const res = await post({ title: '  Buy milk  ', description: '  2% milk  ' });
    expect(res.body.data.title).toBe('Buy milk');
    expect(res.body.data.description).toBe('2% milk');
  });

  it('responds 201 Created', async () => {
    const res = await post({ title: 'Task' });
    expect(res.status).toBe(201);
  });

  it('responds with an application/json Content-Type', async () => {
    const res = await post({ title: 'Task' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('responds with success: true', async () => {
    const res = await post({ title: 'Task' });
    expect(res.body.success).toBe(true);
  });

  it('returns data containing a persistent identifier', async () => {
    const res = await post({ title: 'Task' });
    expect(res.body.data._id).toEqual(expect.any(String));
    expect(res.body.data._id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('returns createdAt and updatedAt timestamps', async () => {
    const res = await post({ title: 'Task' });
    expect(res.body.data.createdAt).toEqual(expect.any(String));
    expect(res.body.data.updatedAt).toEqual(expect.any(String));
  });

  it('actually persists the task to the database', async () => {
    const res = await post({ title: 'Persisted task' });
    const stored = await Task.findById(res.body.data._id);
    expect(stored).not.toBeNull();
    expect(stored.title).toBe('Persisted task');
  });
});

describe('POST /api/tasks — title validation', () => {
  it('rejects a missing title', async () => {
    const res = await post({ description: 'no title' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a null title', async () => {
    const res = await post({ title: null });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string title', async () => {
    const res = await post({ title: 12345 });
    expect(res.status).toBe(400);
  });

  it('rejects an empty title', async () => {
    const res = await post({ title: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only title', async () => {
    const res = await post({ title: '     ' });
    expect(res.status).toBe(400);
  });

  it('rejects a title shorter than 3 characters', async () => {
    const res = await post({ title: 'ab' });
    expect(res.status).toBe(400);
  });

  it('accepts a title of exactly 3 characters', async () => {
    const res = await post({ title: 'abc' });
    expect(res.status).toBe(201);
  });

  it('accepts a title of exactly 100 characters', async () => {
    const res = await post({ title: 'a'.repeat(100) });
    expect(res.status).toBe(201);
    expect(res.body.data.title).toHaveLength(100);
  });

  it('rejects a title longer than 100 characters', async () => {
    const res = await post({ title: 'a'.repeat(101) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks — description validation', () => {
  it('allows description to be omitted', async () => {
    const res = await post({ title: 'Task' });
    expect(res.status).toBe(201);
  });

  it('allows an empty description', async () => {
    const res = await post({ title: 'Task', description: '' });
    expect(res.status).toBe(201);
  });

  it('accepts a description of exactly 1000 characters', async () => {
    const res = await post({ title: 'Task', description: 'd'.repeat(1000) });
    expect(res.status).toBe(201);
  });

  it('rejects a description longer than 1000 characters', async () => {
    const res = await post({ title: 'Task', description: 'd'.repeat(1001) });
    expect(res.status).toBe(400);
  });

  it('rejects a description with an invalid type', async () => {
    const res = await post({ title: 'Task', description: { nested: true } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks — enumerations', () => {
  it.each(['low', 'medium', 'high'])('accepts priority "%s"', async (priority) => {
    const res = await post({ title: 'Task', priority, status: 'todo', completed: false });
    expect(res.status).toBe(201);
    expect(res.body.data.priority).toBe(priority);
  });

  it('rejects an invalid priority', async () => {
    const res = await post({ title: 'Task', priority: 'urgent' });
    expect(res.status).toBe(400);
  });

  it('accepts status "todo" (with completed false)', async () => {
    const res = await post({ title: 'Task', status: 'todo', completed: false });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('todo');
  });

  it('accepts status "in-progress" (with completed false)', async () => {
    const res = await post({ title: 'Task', status: 'in-progress', completed: false });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('in-progress');
  });

  it('accepts status "done" (with completed true)', async () => {
    const res = await post({ title: 'Task', status: 'done', completed: true });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('done');
  });

  it('rejects an invalid status', async () => {
    const res = await post({ title: 'Task', status: 'archived' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid completed type', async () => {
    // validateCreateTask does not itself check `completed` (only
    // validateUpdateTask does); a genuinely wrong type is still rejected
    // one layer down, by the Mongoose schema's own CastError -> 400 path —
    // see docs/phase-04-automated-testing.md for the one narrow exception
    // this does NOT cover (specific boolean-ish strings like "yes"/"no").
    const res = await post({ title: 'Task', completed: 'banana' });
    expect(res.status).toBe(400);
  });

  // Phase 6 closed this gap. Until then, create did not check `completed` at
  // all and Mongoose's permissive Boolean cast defined the contract, so
  // "yes"/"no"/1/0 were silently accepted. The old behaviour was recorded here
  // as a known defect; it is now a rejection, and the full matrix of bad types
  // lives in tests/integration/security.input.test.js.
  it('rejects a boolean-ish string on create (Phase 6: was 201, now 400)', async () => {
    const res = await post({ title: 'Task', completed: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/completed/i);
  });
});

describe('POST /api/tasks — unknown and malformed input', () => {
  it('accepts an unknown field by silently ignoring it (create has no field whitelist)', async () => {
    // This is the actual approved Phase 3 contract: only the UPDATE
    // endpoint rejects unrecognized fields. Mongoose itself silently drops
    // fields the schema does not declare.
    const res = await post({ title: 'Task', hackField: true });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('hackField');

    const stored = await Task.findById(res.body.data._id).lean();
    expect(stored).not.toHaveProperty('hackField');
  });

  it('accepts multiple unknown fields the same way', async () => {
    const res = await post({ title: 'Task', hackField: true, other: 123 });
    expect(res.status).toBe(201);
    expect(res.body.data).not.toHaveProperty('hackField');
    expect(res.body.data).not.toHaveProperty('other');
  });

  it('rejects an empty body', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });

  it('does not expose stack traces, parser internals or the raw malformed body', async () => {
    const malformedBody = '{"title": "leak-me"' + '!!!broken';
    const res = await api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send(malformedBody);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('leak-me');
    expect(raw).not.toContain('SyntaxError');
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toContain('at ');
    expect(raw).not.toContain('body-parser');
  });
});

describe('POST /api/tasks — completed/status invariant', () => {
  it('status "done" alone stores completed: true', async () => {
    const res = await post({ title: 'Task', status: 'done' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'done', completed: true });
  });

  it('status "todo" alone stores completed: false', async () => {
    const res = await post({ title: 'Task', status: 'todo' });
    expect(res.body.data).toMatchObject({ status: 'todo', completed: false });
  });

  it('status "in-progress" alone stores completed: false', async () => {
    const res = await post({ title: 'Task', status: 'in-progress' });
    expect(res.body.data).toMatchObject({ status: 'in-progress', completed: false });
  });

  it('completed: true alone stores status: "done"', async () => {
    const res = await post({ title: 'Task', completed: true });
    expect(res.body.data).toMatchObject({ completed: true, status: 'done' });
  });

  it('completed: false alone stores the default non-completed status ("todo")', async () => {
    const res = await post({ title: 'Task', completed: false });
    expect(res.body.data).toMatchObject({ completed: false, status: 'todo' });
  });

  it('status "done" + completed: true succeeds', async () => {
    const res = await post({ title: 'Task', status: 'done', completed: true });
    expect(res.status).toBe(201);
  });

  it('status "todo" + completed: false succeeds', async () => {
    const res = await post({ title: 'Task', status: 'todo', completed: false });
    expect(res.status).toBe(201);
  });

  it('status "in-progress" + completed: false succeeds', async () => {
    const res = await post({ title: 'Task', status: 'in-progress', completed: false });
    expect(res.status).toBe(201);
  });

  it('status "done" + completed: false returns 400', async () => {
    const res = await post({ title: 'Task', status: 'done', completed: false });
    expect(res.status).toBe(400);
  });

  it('status "todo" + completed: true returns 400', async () => {
    const res = await post({ title: 'Task', status: 'todo', completed: true });
    expect(res.status).toBe(400);
  });

  it('status "in-progress" + completed: true returns 400', async () => {
    const res = await post({ title: 'Task', status: 'in-progress', completed: true });
    expect(res.status).toBe(400);
  });

  it('contradictory input produces no database write', async () => {
    await post({ title: 'Never persisted', status: 'done', completed: false });
    const stored = await Task.findOne({ title: 'Never persisted' });
    expect(stored).toBeNull();
    expect(await Task.countDocuments()).toBe(0);
  });
});
