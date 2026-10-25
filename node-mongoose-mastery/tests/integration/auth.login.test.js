import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { buildRegisterPayload } from '../setup/auth.js';

function login(body) {
  return request(app).post('/api/auth/login').send(body);
}

async function registerUser(overrides = {}) {
  const payload = buildRegisterPayload(overrides);
  await request(app).post('/api/auth/register').send(payload);
  return payload;
}

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  await clearTestDatabase();
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('POST /api/auth/login — success', () => {
  it('responds 200 for correct credentials', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });
    expect(res.status).toBe(200);
  });

  it('returns a token and a user inside the data envelope', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });

    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.user).toEqual(expect.any(Object));
  });

  it('returns a three-part JWT', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });
    expect(res.body.data.token.split('.')).toHaveLength(3);
  });

  it('issues a token that actually works on a protected route', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.data.token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(user.email.toLowerCase());
  });

  it('accepts a differently-cased email', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email.toUpperCase(), password: user.password });
    expect(res.status).toBe(200);
  });

  it('accepts an email with surrounding whitespace', async () => {
    const user = await registerUser();
    const res = await login({ email: `  ${user.email}  `, password: user.password });
    expect(res.status).toBe(200);
  });

  it('never returns the password or hash', async () => {
    const user = await registerUser({ password: 'my-secret-password' });
    const res = await login({ email: user.email, password: 'my-secret-password' });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('my-secret-password');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$2b$');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('returns only the intended public user fields', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });
    expect(Object.keys(res.body.data.user).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'updatedAt',
    ]);
  });

  it('the token payload carries no email or hash (a JWT is signed, not encrypted)', async () => {
    const user = await registerUser({ password: 'my-secret-password' });
    const res = await login({ email: user.email, password: 'my-secret-password' });

    const payload = Buffer.from(res.body.data.token.split('.')[1], 'base64url').toString();

    expect(payload).not.toContain('my-secret-password');
    expect(payload).not.toContain('$2b$');
    expect(payload).not.toContain(user.email.toLowerCase());
  });

  it('the token carries an expiry', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });

    const payload = JSON.parse(
      Buffer.from(res.body.data.token.split('.')[1], 'base64url').toString()
    );

    expect(payload.exp).toEqual(expect.any(Number));
    // Default configured lifetime is 1 hour; allow a little slack for
    // execution time rather than asserting an exact second.
    const lifetimeSeconds = payload.exp - payload.iat;
    expect(lifetimeSeconds).toBeGreaterThan(3500);
    expect(lifetimeSeconds).toBeLessThanOrEqual(3600);
  });
});

describe('POST /api/auth/login — failures (security critical)', () => {
  it('rejects a wrong password with 401', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: 'definitely-not-the-password' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unknown email with 401', async () => {
    const res = await login({ email: 'nobody-here@example.com', password: 'anything-at-all' });
    expect(res.status).toBe(401);
  });

  it('returns no token on a failed login', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: 'wrong-password' });
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('token');
  });

  it('gives byte-identical responses for unknown email and wrong password', async () => {
    // If these differed, login would become a membership oracle: an attacker
    // could confirm which addresses have accounts without guessing a single
    // password.
    const user = await registerUser();

    const wrongPassword = await login({ email: user.email, password: 'wrong-password' });
    const unknownEmail = await login({ email: 'nobody-here@example.com', password: 'wrong-password' });

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('a near-miss password (one character off) is rejected', async () => {
    const user = await registerUser({ password: 'almost-right-password' });
    const res = await login({ email: user.email, password: 'almost-right-passwore' });
    expect(res.status).toBe(401);
  });

  it('is case-sensitive about the password', async () => {
    const user = await registerUser({ password: 'CaseSensitive123' });
    const res = await login({ email: user.email, password: 'casesensitive123' });
    expect(res.status).toBe(401);
  });

  it('does not leak whether the account exists in the error message', async () => {
    const res = await login({ email: 'nobody-here@example.com', password: 'anything-at-all' });
    expect(res.body.message).not.toMatch(/no account|not found|unknown|does not exist/i);
  });

  it.each([
    ['a missing email', { password: 'anything' }],
    ['a missing password', { email: 'a@example.com' }],
    ['an empty body', {}],
    ['an empty password', { email: 'a@example.com', password: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await login(body);
    expect(res.status).toBe(400);
  });

  it('rejects an unknown field', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password, role: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('role');
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
  });

  it('requires no authentication itself', async () => {
    const user = await registerUser();
    const res = await login({ email: user.email, password: user.password });
    expect(res.status).toBe(200);
  });
});
