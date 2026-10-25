import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { buildRegisterPayload, uniqueEmail } from '../setup/auth.js';

// These tests go through the real endpoint with real bcrypt, so the hashing
// guarantees below are genuine rather than mocked.

function register(body) {
  return request(app).post('/api/auth/register').send(body);
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

describe('POST /api/auth/register — success', () => {
  it('creates an account and responds 201', async () => {
    const res = await register(buildRegisterPayload());
    expect(res.status).toBe(201);
  });

  it('uses the standard success envelope', async () => {
    const res = await register(buildRegisterPayload());
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(expect.any(Object));
  });

  it('returns the created user with an id, name and email', async () => {
    const payload = buildRegisterPayload({ name: 'Ada Lovelace' });
    const res = await register(payload);
    expect(res.body.data).toMatchObject({
      name: 'Ada Lovelace',
      email: payload.email.toLowerCase(),
    });
    expect(res.body.data.id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('persists the user to the database', async () => {
    const payload = buildRegisterPayload();
    await register(payload);
    const stored = await User.findOne({ email: payload.email.toLowerCase() });
    expect(stored).not.toBeNull();
  });

  it('lowercases and trims the stored email', async () => {
    const payload = buildRegisterPayload({ email: '  MixedCase@Example.COM  ' });
    const res = await register(payload);
    expect(res.body.data.email).toBe('mixedcase@example.com');
    const stored = await User.findOne({ email: 'mixedcase@example.com' });
    expect(stored).not.toBeNull();
  });

  it('trims the stored name', async () => {
    const res = await register(buildRegisterPayload({ name: '  Ada Lovelace  ' }));
    expect(res.body.data.name).toBe('Ada Lovelace');
  });

  it('allows two different users to register', async () => {
    expect((await register(buildRegisterPayload())).status).toBe(201);
    expect((await register(buildRegisterPayload())).status).toBe(201);
    expect(await User.countDocuments()).toBe(2);
  });
});

describe('POST /api/auth/register — password storage (security critical)', () => {
  it('stores a bcrypt hash, never the plaintext password', async () => {
    const payload = buildRegisterPayload({ password: 'my-secret-password' });
    await register(payload);

    // select: false means the hash must be asked for explicitly.
    const stored = await User.findOne({ email: payload.email.toLowerCase() }).select('+passwordHash');

    expect(stored.passwordHash).toEqual(expect.any(String));
    expect(stored.passwordHash).not.toBe('my-secret-password');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(stored.passwordHash).toHaveLength(60);
  });

  it('stores no field anywhere in the document containing the plaintext password', async () => {
    const payload = buildRegisterPayload({ password: 'my-secret-password' });
    await register(payload);

    const raw = await User.collection.findOne({ email: payload.email.toLowerCase() });

    expect(JSON.stringify(raw)).not.toContain('my-secret-password');
    expect(raw).not.toHaveProperty('password');
  });

  it('the stored hash actually verifies the original password', async () => {
    const payload = buildRegisterPayload({ password: 'my-secret-password' });
    await register(payload);

    // Proven through the real login endpoint rather than by calling bcrypt
    // here: what matters is that the credential works end to end.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: payload.email, password: 'my-secret-password' });

    expect(login.status).toBe(200);
  });

  it('two users with the identical password get different hashes (salting)', async () => {
    const a = buildRegisterPayload({ password: 'identical-password' });
    const b = buildRegisterPayload({ password: 'identical-password' });
    await register(a);
    await register(b);

    const storedA = await User.findOne({ email: a.email.toLowerCase() }).select('+passwordHash');
    const storedB = await User.findOne({ email: b.email.toLowerCase() }).select('+passwordHash');

    expect(storedA.passwordHash).not.toBe(storedB.passwordHash);
  });

  it('never returns the password or hash in the response', async () => {
    const payload = buildRegisterPayload({ password: 'my-secret-password' });
    const res = await register(payload);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('my-secret-password');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$2b$');
    expect(res.body.data).not.toHaveProperty('password');
    expect(res.body.data).not.toHaveProperty('passwordHash');
  });

  it('exposes only the intended public fields', async () => {
    const res = await register(buildRegisterPayload());
    expect(Object.keys(res.body.data).sort()).toEqual([
      'createdAt',
      'email',
      'id',
      'name',
      'updatedAt',
    ]);
  });
});

describe('POST /api/auth/register — duplicate email', () => {
  it('rejects a duplicate email with 409', async () => {
    const payload = buildRegisterPayload();
    await register(payload);
    const res = await register({ ...payload, name: 'Someone Else' });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('treats a differently-cased duplicate as the same email', async () => {
    const email = uniqueEmail('CaseTest').toUpperCase();
    await register(buildRegisterPayload({ email: email.toLowerCase() }));
    const res = await register(buildRegisterPayload({ email }));
    expect(res.status).toBe(409);
  });

  it('does not create a second document for a duplicate', async () => {
    const payload = buildRegisterPayload();
    await register(payload);
    await register(payload);
    expect(await User.countDocuments()).toBe(1);
  });

  it('does not reveal the existing account holder in the error', async () => {
    const payload = buildRegisterPayload({ name: 'Original Owner' });
    await register(payload);
    const res = await register({ ...payload, name: 'Impostor' });
    expect(JSON.stringify(res.body)).not.toContain('Original Owner');
  });
});

describe('POST /api/auth/register — validation', () => {
  it.each([
    ['a missing name', { email: 'a@example.com', password: 'a-password' }],
    ['a short name', { name: 'ab', email: 'a@example.com', password: 'a-password' }],
    ['a missing email', { name: 'Ada', password: 'a-password' }],
    ['an invalid email', { name: 'Ada', email: 'not-an-email', password: 'a-password' }],
    ['a missing password', { name: 'Ada', email: 'a@example.com' }],
    ['a short password', { name: 'Ada', email: 'a@example.com', password: 'short7' }],
    ['an empty body', {}],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await register(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts a password of exactly 8 characters (boundary)', async () => {
    const res = await register(buildRegisterPayload({ password: '12345678' }));
    expect(res.status).toBe(201);
  });

  it('rejects an attempt to supply passwordHash directly', async () => {
    const res = await register({
      ...buildRegisterPayload(),
      passwordHash: '$2b$12$attackerControlledHashValueGoesHereXXXXXXXXXXXXXXXXXXXXXX',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('passwordHash');
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects an attempt to supply an _id', async () => {
    const res = await register({ ...buildRegisterPayload(), _id: '64b7f1f1f1f1f1f1f1f1f1aa' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{not valid json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });

  it('does not create a user when validation fails', async () => {
    await register({ name: 'ab', email: 'bad', password: 'short' });
    expect(await User.countDocuments()).toBe(0);
  });

  it('requires no authentication (it is how you get credentials)', async () => {
    const res = await register(buildRegisterPayload());
    expect(res.status).toBe(201);
  });
});
