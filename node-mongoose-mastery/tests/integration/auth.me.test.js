import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { createTestUser } from '../setup/auth.js';

let authed;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
  authed = await createTestUser({ name: 'Ada Lovelace' });
});

afterAll(async () => {
  await disconnectTestDatabase();
});

function me(token) {
  const req = request(app).get('/api/auth/me');
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
}

describe('GET /api/auth/me — authenticated', () => {
  it('returns 200 with the current user', async () => {
    const res = await me(authed.token);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: authed.id, name: 'Ada Lovelace' });
  });

  it('returns the user matching the token, not an arbitrary one', async () => {
    const other = await createTestUser({ name: 'Grace Hopper' });

    const first = await me(authed.token);
    const second = await me(other.token);

    expect(first.body.data.id).toBe(authed.id);
    expect(second.body.data.id).toBe(other.id);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });

  it('never returns the password hash', async () => {
    const res = await me(authed.token);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$2b$');
    expect(res.body.data).not.toHaveProperty('passwordHash');
    expect(res.body.data).not.toHaveProperty('password');
  });

  it('returns only the intended public fields', async () => {
    const res = await me(authed.token);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'updatedAt',
    ]);
  });
});

describe('GET /api/auth/me — rejected credentials', () => {
  it('rejects a missing Authorization header with 401', async () => {
    const res = await me(undefined);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a malformed token with 401', async () => {
    const res = await me('this-is-not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const forged = jwt.sign({ sub: authed.id }, 'an-attackers-own-secret', { expiresIn: '1h' });
    const res = await me(forged);
    expect(res.status).toBe(401);
  });

  it('rejects a tampered payload with 401', async () => {
    const [header, , signature] = authed.token.split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: '64b7f1f1f1f1f1f1f1f1f1bb' })).toString(
      'base64url'
    );
    const res = await me(`${header}.${swapped}.${signature}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with 401', async () => {
    const expired = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await me(expired);
    expect(res.status).toBe(401);
  });

  it('rejects a token whose account has since been deleted', async () => {
    await User.deleteOne({ _id: authed.userId });
    const res = await me(authed.token);
    expect(res.status).toBe(401);
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Basic ${authed.token}`);
    expect(res.status).toBe(401);
  });

  it('never leaks internals in an auth failure', async () => {
    const res = await me('this-is-not-a-jwt');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('node_modules');
    expect(raw).not.toMatch(/at .*:\d+:\d+/);
    expect(raw).not.toContain('secret');
    expect(Object.keys(res.body).sort()).toEqual(['message', 'success']);
  });
});
