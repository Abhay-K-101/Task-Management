import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app.js';
import Task from '../../src/models/task.model.js';
import User from '../../src/models/user.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';

// Phase 5 turned every task route into a protected one. This file proves
// that for each route and each way a token can be wrong.

let authed;
let taskId;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  authed = await createTestUser();
  const created = await authed.api.post('/api/tasks').send({ title: 'An existing task' });
  taskId = created.body.data._id;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

// Every protected task route, as [label, method, path builder].
const PROTECTED_ROUTES = [
  ['POST /api/tasks', (token) => withToken(request(app).post('/api/tasks').send({ title: 'New task' }), token)],
  ['GET /api/tasks', (token) => withToken(request(app).get('/api/tasks'), token)],
  ['GET /api/tasks/:id', (token, id) => withToken(request(app).get(`/api/tasks/${id}`), token)],
  ['PATCH /api/tasks/:id', (token, id) => withToken(request(app).patch(`/api/tasks/${id}`).send({ title: 'Changed' }), token)],
  ['DELETE /api/tasks/:id', (token, id) => withToken(request(app).delete(`/api/tasks/${id}`), token)],
];

function withToken(req, token) {
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
}

describe('Protected task routes — missing JWT', () => {
  it.each(PROTECTED_ROUTES)('%s returns 401 without a token', async (_label, build) => {
    const res = await build(undefined, taskId);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: expect.any(String) });
  });

  it('a rejected write makes no change to the database', async () => {
    const before = await Task.countDocuments();
    await request(app).post('/api/tasks').send({ title: 'Should never exist' });
    expect(await Task.countDocuments()).toBe(before);
  });

  it('a rejected delete leaves the task in place', async () => {
    await request(app).delete(`/api/tasks/${taskId}`);
    expect(await Task.findById(taskId)).not.toBeNull();
  });

  it('a rejected update leaves the task unchanged', async () => {
    await request(app).patch(`/api/tasks/${taskId}`).send({ title: 'Tampered' });
    const stored = await Task.findById(taskId);
    expect(stored.title).toBe('An existing task');
  });
});

describe('Protected task routes — malformed, tampered and expired JWTs', () => {
  it.each(PROTECTED_ROUTES)('%s returns 401 for a malformed token', async (_label, build) => {
    const res = await build('not-a-jwt-at-all', taskId);
    expect(res.status).toBe(401);
  });

  it.each(PROTECTED_ROUTES)('%s returns 401 for a token signed with another secret', async (_label, build) => {
    const forged = jwt.sign({ sub: authed.id }, 'an-attackers-own-secret', { expiresIn: '1h' });
    const res = await build(forged, taskId);
    expect(res.status).toBe(401);
  });

  it.each(PROTECTED_ROUTES)('%s returns 401 for an expired token', async (_label, build) => {
    const expired = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await build(expired, taskId);
    expect(res.status).toBe(401);
  });

  it('rejects a token whose payload was swapped but signature kept', async () => {
    const other = await createTestUser();
    const [header, , signature] = authed.token.split('.');
    const swappedPayload = Buffer.from(JSON.stringify({ sub: other.id })).toString('base64url');

    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${header}.${swappedPayload}.${signature}`);

    expect(res.status).toBe(401);
  });

  it('rejects an "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: authed.id })).toString('base64url');

    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', `Bearer ${header}.${payload}.`);

    expect(res.status).toBe(401);
  });

  it('rejects a valid token whose user has been deleted', async () => {
    await User.deleteOne({ _id: authed.userId });
    const res = await authed.api.get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('a tampered-token write makes no change to the database', async () => {
    const before = await Task.countDocuments();
    await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer not-a-jwt-at-all')
      .send({ title: 'Should never exist' });
    expect(await Task.countDocuments()).toBe(before);
  });
});

describe('Middleware ordering — authentication runs before validation', () => {
  it('an unauthenticated request with an invalid body returns 401, not 400', async () => {
    // Order matters: a 400 here would confirm the endpoint's field rules to
    // someone who has not proven they may use the endpoint at all.
    const res = await request(app).post('/api/tasks').send({ title: 'ab' });
    expect(res.status).toBe(401);
  });

  it('an authenticated request with an invalid body still returns 400', async () => {
    const res = await authed.api.post('/api/tasks').send({ title: 'ab' });
    expect(res.status).toBe(400);
  });

  it('an unauthenticated request with malformed JSON returns 400 (the body parser runs first)', async () => {
    // express.json() is app-level middleware, so it runs ahead of the router
    // and its own failure short-circuits before requireAuth is reached. This
    // documents the actual, observed order rather than an assumed one.
    const res = await request(app)
      .post('/api/tasks')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });
});

describe('Public surface is unchanged by authentication', () => {
  it('an unknown route still returns 404, not 401', async () => {
    const res = await request(app).get('/api/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Route not found' });
  });

  it('an unregistered method on a known path still returns 404, not 401', async () => {
    // requireAuth is attached per route rather than with router.use(), so a
    // method with no registered handler falls through to the 404 handler
    // exactly as it did in Phase 3/4.
    const res = await request(app).put('/api/tasks').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Route not found' });
  });

  it('register and login remain reachable without a token', async () => {
    expect((await request(app).post('/api/auth/register').send({})).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
  });
});
