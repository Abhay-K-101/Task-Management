import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import Task from '../../src/models/task.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser } from '../setup/auth.js';
import { seedTasks } from '../setup/test-data.js';

let authed;
let ownerId;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  // The real app's limiters are process-wide singletons. Clearing them
  // here means no test file can inherit counters from another.
  resetRateLimiters();
  await clearTestDatabase();
  authed = await createTestUser();
  ownerId = authed.userId;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

// Values that are NOT JSON booleans. Every one of these used to be accepted on
// create, because create did not check the field and Mongoose's Boolean cast
// is far more permissive than the public contract should be.
const NON_BOOLEANS = [
  ['the string "true"', 'true'],
  ['the string "false"', 'false'],
  ['the string "yes"', 'yes'],
  ['the string "no"', 'no'],
  ['the number 1', 1],
  ['the number 0', 0],
  ['null', null],
  ['an empty array', []],
  ['an object', {}],
  ['an array of booleans', [true]],
  ['the string "TRUE"', 'TRUE'],
];

describe('strict boolean: POST /api/tasks', () => {
  it.each(NON_BOOLEANS)('rejects completed as %s', async (_label, value) => {
    const res = await authed.api.post('/api/tasks').send({ title: 'Boolean probe', completed: value });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/completed/i);
  });

  it.each(NON_BOOLEANS)('writes nothing when completed is %s', async (_label, value) => {
    await authed.api.post('/api/tasks').send({ title: 'Boolean probe', completed: value });
    expect(await Task.countDocuments()).toBe(0);
  });

  it.each([true, false])('still accepts the real boolean %s', async (value) => {
    const res = await authed.api.post('/api/tasks').send({ title: 'Boolean probe', completed: value });

    expect(res.status).toBe(201);
    expect(res.body.data.completed).toBe(value);
  });

  it('a stored task never has a null completed', async () => {
    // The specific defect this closes: `completed: null` used to persist as
    // null alongside status "todo", quietly violating the completed/status
    // invariant that says "todo" implies completed === false.
    await authed.api.post('/api/tasks').send({ title: 'Null probe', completed: null });
    await authed.api.post('/api/tasks').send({ title: 'Valid task' });

    const nulls = await Task.countDocuments({ completed: null });
    expect(nulls).toBe(0);
  });

  it('the completed/status invariant is unchanged', async () => {
    const derived = await authed.api.post('/api/tasks').send({ title: 'Derived', status: 'done' });
    expect(derived.body.data.completed).toBe(true);

    const contradiction = await authed.api
      .post('/api/tasks')
      .send({ title: 'Contradiction', status: 'done', completed: false });
    expect(contradiction.status).toBe(400);
  });
});

describe('strict boolean: PATCH /api/tasks/:id', () => {
  async function existingTask() {
    const res = await authed.api.post('/api/tasks').send({ title: 'Patch target' });
    return res.body.data;
  }

  it.each(NON_BOOLEANS)('rejects completed as %s', async (_label, value) => {
    const task = await existingTask();
    const res = await authed.api.patch(`/api/tasks/${task._id}`).send({ completed: value });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/completed/i);
  });

  it.each(NON_BOOLEANS)('leaves the task untouched when completed is %s', async (_label, value) => {
    const task = await existingTask();
    await authed.api.patch(`/api/tasks/${task._id}`).send({ completed: value });

    const stored = await Task.findById(task._id);
    expect(stored.completed).toBe(false);
    expect(stored.status).toBe('todo');
  });

  it.each([true, false])('still accepts the real boolean %s', async (value) => {
    const task = await existingTask();
    const res = await authed.api.patch(`/api/tasks/${task._id}`).send({ completed: value });
    expect(res.status).toBe(200);
  });

  it('create and update now agree on the rule', async () => {
    // Before Phase 6 these two disagreed: update rejected "yes", create
    // accepted it. A contract that depends on which verb you used is a bug.
    const task = await existingTask();
    const created = await authed.api.post('/api/tasks').send({ title: 'Agree', completed: 'yes' });
    const patched = await authed.api.patch(`/api/tasks/${task._id}`).send({ completed: 'yes' });

    expect(created.status).toBe(400);
    expect(patched.status).toBe(400);
  });
});

// Every parameter the list endpoint recognises, in both ambiguous shapes
// Express can produce: a duplicated key (array) and a bracketed key (object).
const RECOGNISED_PARAMS = ['page', 'limit', 'completed', 'status', 'priority', 'sortBy', 'order', 'search'];

describe('query parameter pollution', () => {
  it.each(RECOGNISED_PARAMS)('rejects a duplicated %s', async (param) => {
    const res = await authed.api.get(`/api/tasks?${param}=1&${param}=2`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(new RegExp(param));
  });

  it.each(RECOGNISED_PARAMS)('rejects an object-shaped %s', async (param) => {
    // `?search[$ne]=x` is how a NoSQL operator gets smuggled through a query
    // string. Refusing the shape means the defence no longer depends on every
    // future filter being written carefully.
    const res = await authed.api.get(`/api/tasks?${param}[$ne]=x`);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(new RegExp(param));
  });

  it.each(RECOGNISED_PARAMS)('rejects a single-element array %s', async (param) => {
    // `?page[0]=1` used to slip through: Number(['1']) is 1, so an array
    // masquerading as a scalar was silently accepted.
    const res = await authed.api.get(`/api/tasks?${param}[0]=todo`);
    expect(res.status).toBe(400);
  });

  it('rejects duplicates even when both values are individually valid', async () => {
    const res = await authed.api.get('/api/tasks?status=todo&status=done');
    expect(res.status).toBe(400);
  });

  it('does not silently pick the first or last value', async () => {
    // Silently choosing one hides a genuine client bug and makes two different
    // requests behave identically for no stated reason.
    await seedTasks([{ title: 'Todo one', status: 'todo', completed: false }], ownerId);
    const res = await authed.api.get('/api/tasks?status=todo&status=done');

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
  });

  it('ordinary single-value parameters still work', async () => {
    await seedTasks(
      [
        { title: 'Alpha task', status: 'todo', priority: 'high', completed: false },
        { title: 'Beta task', status: 'done', priority: 'low', completed: true },
      ],
      ownerId
    );

    const res = await authed.api.get(
      '/api/tasks?status=todo&priority=high&completed=false&sortBy=title&order=asc&page=1&limit=10&search=Alpha'
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Alpha task');
  });

  it('an unrecognised parameter is still ignored, not rejected', async () => {
    // The rule tightens only what the API actually consumes, so a caller
    // appending their own tracking parameter is unaffected.
    await seedTasks([{ title: 'Still here', status: 'todo', completed: false }], ownerId);
    const res = await authed.api.get('/api/tasks?utm_source=newsletter&owner=someone-else');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('search regex characters are still escaped, not executed', async () => {
    await seedTasks([{ title: 'Deploy node service', status: 'todo', completed: false }], ownerId);

    // Unescaped, `node.` would match "node " and return the task.
    const res = await authed.api.get(`/api/tasks?search=${encodeURIComponent('node.')}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('a rejected query never reaches the database', async () => {
    await seedTasks([{ title: 'Untouched', status: 'todo', completed: false }], ownerId);
    const before = await Task.countDocuments();

    await authed.api.get('/api/tasks?limit=1&limit=2');

    expect(await Task.countDocuments()).toBe(before);
  });
});

describe('prototype-pollution shaped input', () => {
  it('a __proto__ key in a JSON body does not pollute Object.prototype', async () => {
    // Observed behaviour, not an assumption: JSON.parse creates a plain own
    // property rather than invoking the prototype setter, and Mongoose then
    // drops the field because the schema does not declare it.
    const res = await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{"title":"Proto probe","__proto__":{"polluted":"yes"}}');

    expect([201, 400]).toContain(res.status);
    expect({}.polluted).toBeUndefined();
  });

  it('a constructor.prototype shaped body does not pollute Object.prototype', async () => {
    await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{"title":"Proto probe two","constructor":{"prototype":{"polluted":"yes"}}}');

    expect({}.polluted).toBeUndefined();
  });

  it('a __proto__ query key does not pollute Object.prototype', async () => {
    const res = await authed.api.get('/api/tasks?__proto__[polluted]=yes');

    expect(res.status).toBe(200);
    expect({}.polluted).toBeUndefined();
  });

  it('a polluted-looking key never becomes a stored task field', async () => {
    const res = await authed.api
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{"title":"Proto probe three","__proto__":{"admin":true}}');

    if (res.status === 201) {
      const stored = await Task.findById(res.body.data._id).lean();
      expect(stored.admin).toBeUndefined();
    }
  });
});

describe('content type handling', () => {
  it('a JSON write with no Content-Type is rejected by validation, not accepted blindly', async () => {
    // express.json() only parses when the type matches, so the body is simply
    // never populated and the validators reject the empty request. Express
    // already fails safely here, so no bespoke 415 rule is introduced.
    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${authed.token}`)
      .set('Content-Type', 'text/plain')
      .send('title=Sneaky');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await Task.countDocuments()).toBe(0);
  });

  it('a body-less GET without Content-Type works normally', async () => {
    const res = await authed.api.get('/api/tasks');
    expect(res.status).toBe(200);
  });

  it('a body-less DELETE without Content-Type works normally', async () => {
    const created = await authed.api.post('/api/tasks').send({ title: 'Delete me please' });
    const res = await authed.api.delete(`/api/tasks/${created.body.data._id}`);
    expect(res.status).toBe(204);
  });
});
