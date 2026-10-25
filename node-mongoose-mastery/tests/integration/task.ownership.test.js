import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Task from '../../src/models/task.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';
import { seedTasks } from '../setup/test-data.js';

// Two users, every time. Alice owns things; Bob is the stranger who must
// never be able to see or touch them.
let alice;
let bob;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  alice = await createTestUser({ name: 'Alice' });
  bob = await createTestUser({ name: 'Bob' });
});

afterAll(async () => {
  await disconnectTestDatabase();
});

async function createTaskFor(user, overrides = {}) {
  const res = await user.api.post('/api/tasks').send({ title: 'A task', ...overrides });
  return res.body.data;
}

describe('Ownership — assignment on create', () => {
  it('sets the owner from the authenticated user', async () => {
    const task = await createTaskFor(alice);
    const stored = await Task.findById(task._id);
    expect(stored.owner.toString()).toBe(alice.id);
  });

  it('gives two different users two differently-owned tasks', async () => {
    const aliceTask = await createTaskFor(alice);
    const bobTask = await createTaskFor(bob);

    const storedA = await Task.findById(aliceTask._id);
    const storedB = await Task.findById(bobTask._id);

    expect(storedA.owner.toString()).toBe(alice.id);
    expect(storedB.owner.toString()).toBe(bob.id);
  });

  it('never creates a task without an owner', async () => {
    await createTaskFor(alice);
    const withoutOwner = await Task.countDocuments({ owner: { $exists: false } });
    expect(withoutOwner).toBe(0);
  });
});

describe('Ownership — owner cannot be chosen by the client (security critical)', () => {
  it('rejects an explicit owner in the create body with 400', async () => {
    const res = await alice.api.post('/api/tasks').send({ title: 'Planted task', owner: bob.id });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('owner');
  });

  it('creates nothing when an owner override is attempted', async () => {
    await alice.api.post('/api/tasks').send({ title: 'Planted task', owner: bob.id });
    expect(await Task.countDocuments()).toBe(0);
  });

  it('rejects an owner override even when it names the caller themselves', async () => {
    // The field is refused on principle, not because the value is wrong —
    // ownership is never client-supplied input.
    const res = await alice.api.post('/api/tasks').send({ title: 'Self owned', owner: alice.id });
    expect(res.status).toBe(400);
  });

  it('rejects an attempt to reassign the owner via PATCH', async () => {
    const task = await createTaskFor(alice);

    const res = await alice.api.patch(`/api/tasks/${task._id}`).send({ owner: bob.id });

    expect(res.status).toBe(400);
    const stored = await Task.findById(task._id);
    expect(stored.owner.toString()).toBe(alice.id);
  });

  it('does not expose a way to give a task away', async () => {
    const task = await createTaskFor(alice);
    await alice.api.patch(`/api/tasks/${task._id}`).send({ owner: bob.id });

    // Bob still cannot reach it.
    expect((await bob.api.get(`/api/tasks/${task._id}`)).status).toBe(404);
  });
});

describe('Ownership — listing is scoped to the caller', () => {
  it("a user sees only their own tasks", async () => {
    await createTaskFor(alice, { title: 'Alice task one' });
    await createTaskFor(alice, { title: 'Alice task two' });
    await createTaskFor(bob, { title: 'Bob task' });

    const res = await alice.api.get('/api/tasks');

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((t) => t.title).sort()).toEqual(['Alice task one', 'Alice task two']);
  });

  it("a user's totalCount excludes other users' tasks", async () => {
    await seedTasks(
      Array.from({ length: 12 }, (_, i) => ({ title: `Bob task ${i}` })),
      bob.userId
    );
    await createTaskFor(alice, { title: 'The only Alice task' });

    const res = await alice.api.get('/api/tasks');

    expect(res.body.pagination.totalCount).toBe(1);
    expect(res.body.pagination.totalPages).toBe(1);
  });

  it('a user with no tasks sees an empty list even when others have many', async () => {
    await seedTasks([{ title: 'Bob one' }, { title: 'Bob two' }], bob.userId);

    const res = await alice.api.get('/api/tasks');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.totalCount).toBe(0);
  });

  it('filtering stays scoped to the caller', async () => {
    await seedTasks([{ title: 'Bob high', priority: 'high', status: 'todo', completed: false }], bob.userId);
    await createTaskFor(alice, { title: 'Alice high', priority: 'high' });

    const res = await alice.api.get('/api/tasks?priority=high');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Alice high');
  });

  it('search stays scoped to the caller', async () => {
    await seedTasks([{ title: 'Shared keyword bob', status: 'todo', completed: false }], bob.userId);
    await createTaskFor(alice, { title: 'Shared keyword alice' });

    const res = await alice.api.get('/api/tasks?search=Shared%20keyword');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Shared keyword alice');
  });

  it('pagination stays scoped to the caller', async () => {
    await seedTasks(
      Array.from({ length: 20 }, (_, i) => ({ title: `Bob ${i}` })),
      bob.userId
    );
    await seedTasks(
      Array.from({ length: 3 }, (_, i) => ({ title: `Alice ${i}` })),
      alice.userId
    );

    const res = await alice.api.get('/api/tasks?page=1&limit=10');

    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.totalCount).toBe(3);
    expect(res.body.pagination.hasNextPage).toBe(false);
  });

  it('sorting stays scoped to the caller', async () => {
    await seedTasks([{ title: 'AAA bob would sort first' }], bob.userId);
    await createTaskFor(alice, { title: 'ZZZ alice' });

    const res = await alice.api.get('/api/tasks?sortBy=title&order=asc');

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('ZZZ alice');
  });
});

describe('Ownership — the scope cannot be widened by request input', () => {
  it('an owner query parameter is ignored, not honoured', async () => {
    await createTaskFor(alice, { title: 'Alice only' });
    await createTaskFor(bob, { title: 'Bob only' });

    // buildFilter only recognises completed/status/priority, and the
    // repository applies `owner` last regardless — so this is ignored twice
    // over.
    const res = await alice.api.get(`/api/tasks?owner=${bob.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Alice only');
  });

  it('an owner[$ne] style operator in the query string does not widen the scope', async () => {
    await createTaskFor(alice, { title: 'Alice only' });
    await createTaskFor(bob, { title: 'Bob only' });

    const res = await alice.api.get('/api/tasks?owner[$ne]=null');

    expect(res.status).toBe(200);
    expect(res.body.data.map((t) => t.title)).toEqual(['Alice only']);
  });

  it('a search term cannot reach another user\'s tasks', async () => {
    await createTaskFor(bob, { title: 'Bob secret plan' });

    const res = await alice.api.get('/api/tasks?search=secret');

    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.totalCount).toBe(0);
  });
});

describe('Ownership — cross-user access returns 404, never 403 (security critical)', () => {
  it("reading another user's task returns 404", async () => {
    const aliceTask = await createTaskFor(alice, { title: 'Private to Alice' });

    const res = await bob.api.get(`/api/tasks/${aliceTask._id}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("updating another user's task returns 404", async () => {
    const aliceTask = await createTaskFor(alice, { title: 'Private to Alice' });

    const res = await bob.api.patch(`/api/tasks/${aliceTask._id}`).send({ title: 'Bob was here' });

    expect(res.status).toBe(404);
  });

  it("deleting another user's task returns 404", async () => {
    const aliceTask = await createTaskFor(alice);

    const res = await bob.api.delete(`/api/tasks/${aliceTask._id}`);

    expect(res.status).toBe(404);
  });

  it("a failed cross-user update does not modify the task", async () => {
    const aliceTask = await createTaskFor(alice, { title: 'Untouched' });

    await bob.api.patch(`/api/tasks/${aliceTask._id}`).send({ title: 'Bob was here' });

    const stored = await Task.findById(aliceTask._id);
    expect(stored.title).toBe('Untouched');
    expect(stored.owner.toString()).toBe(alice.id);
  });

  it("a failed cross-user delete does not remove the task", async () => {
    const aliceTask = await createTaskFor(alice);

    await bob.api.delete(`/api/tasks/${aliceTask._id}`);

    expect(await Task.findById(aliceTask._id)).not.toBeNull();
  });

  it("the owner can still reach the task after another user's failed attempt", async () => {
    const aliceTask = await createTaskFor(alice, { title: 'Still mine' });

    await bob.api.delete(`/api/tasks/${aliceTask._id}`);
    const res = await alice.api.get(`/api/tasks/${aliceTask._id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Still mine');
  });

  it("someone else's task id is indistinguishable from one that never existed", async () => {
    // This is the whole reason for answering 404 rather than 403: a 403 would
    // confirm "this id exists, it just isn't yours", which leaks both the
    // existence of the record and, by extension, other users' activity.
    const aliceTask = await createTaskFor(alice);
    const nonexistentId = '64b7f1f1f1f1f1f1f1f1f1f1';

    const othersTask = await bob.api.get(`/api/tasks/${aliceTask._id}`);
    const neverExisted = await bob.api.get(`/api/tasks/${nonexistentId}`);

    expect(othersTask.status).toBe(neverExisted.status);
    expect(othersTask.body).toEqual(neverExisted.body);
  });

  it('the 404 body reveals nothing about the real owner', async () => {
    const aliceTask = await createTaskFor(alice);
    const res = await bob.api.get(`/api/tasks/${aliceTask._id}`);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(alice.id);
    expect(raw).not.toContain('Alice');
    expect(raw).not.toContain(alice.email);
  });

  it('never answers 403 for a cross-user attempt', async () => {
    const aliceTask = await createTaskFor(alice);

    const attempts = [
      await bob.api.get(`/api/tasks/${aliceTask._id}`),
      await bob.api.patch(`/api/tasks/${aliceTask._id}`).send({ title: 'Changed' }),
      await bob.api.delete(`/api/tasks/${aliceTask._id}`),
    ];

    for (const res of attempts) {
      expect(res.status).toBe(404);
    }
  });
});

describe('Ownership — the owner field in responses', () => {
  it('a created task reports its owner as the caller', async () => {
    const res = await alice.api.post('/api/tasks').send({ title: 'Mine' });
    expect(String(res.body.data.owner)).toBe(alice.id);
  });

  it("a listed task reports the caller as owner", async () => {
    await createTaskFor(alice);
    const res = await alice.api.get('/api/tasks');
    expect(String(res.body.data[0].owner)).toBe(alice.id);
  });
});
