import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser } from '../setup/auth.js';
import {
  signToken,
  verifyToken,
  assertJwtSecretConfigured,
  JWT_ALGORITHM,
  ALLOWED_ALGORITHMS,
} from '../../src/config/jwt.js';
import { MIN_JWT_SECRET_LENGTH } from '../../src/config/security.js';

let authed;
let savedSecret;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  // The real app's limiters are process-wide singletons. Clearing them
  // here means no test file can inherit counters from another.
  resetRateLimiters();
  await clearTestDatabase();
  savedSecret = process.env.JWT_SECRET;
  authed = await createTestUser();
});

afterEach(() => {
  // Restored unconditionally: a leaked JWT_SECRET change would break every
  // later test in unpredictable ways.
  if (savedSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedSecret;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

function withToken(token) {
  return request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);
}

describe('secret strength policy', () => {
  it('a strong secret is accepted', () => {
    process.env.JWT_SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);
    expect(() => assertJwtSecretConfigured()).not.toThrow();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('a %s secret is refused', (_label, value) => {
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;

    expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
  });

  it.each(['secret', 'dev', 'password123', 'node-mongoose-mastery'])(
    'a weak secret (%j) is refused',
    (weak) => {
      // These are the secrets people actually pick under deadline pressure.
      process.env.JWT_SECRET = weak;
      expect(() => assertJwtSecretConfigured()).toThrow(/at least/i);
    }
  );

  it('one character under the minimum is refused, exactly at it is accepted', () => {
    process.env.JWT_SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH - 1);
    expect(() => assertJwtSecretConfigured()).toThrow();

    process.env.JWT_SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);
    expect(() => assertJwtSecretConfigured()).not.toThrow();
  });

  it('the error never contains the secret value', () => {
    const weak = 'weak-secret-value-do-not-print';
    process.env.JWT_SECRET = weak;

    let thrown;
    try {
      assertJwtSecretConfigured();
    } catch (error) {
      thrown = error;
    }

    expect(thrown.message).not.toContain(weak);
    expect(thrown.message).toMatch(/JWT_SECRET must be at least \d+ characters/);
  });

  it('signing and verifying both enforce the policy', () => {
    process.env.JWT_SECRET = 'too-short';
    expect(() => signToken('64b7f1f1f1f1f1f1f1f1f1aa')).toThrow(/at least/i);
    expect(() => verifyToken('any.token.here')).toThrow(/at least/i);
  });
});

describe('algorithm pinning', () => {
  it('only HS256 is accepted', () => {
    expect(JWT_ALGORITHM).toBe('HS256');
    expect(ALLOWED_ALGORITHMS).toEqual(['HS256']);
  });

  it('tokens are signed with the pinned algorithm', () => {
    const header = JSON.parse(Buffer.from(authed.token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
  });

  it('rejects an "alg: none" token', async () => {
    // The classic attack: strip the signature and claim none is needed. An
    // explicit algorithms allow-list is what refuses it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: authed.id })).toString('base64url');

    const res = await withToken(`${header}.${payload}.`);
    expect(res.status).toBe(401);
  });

  it('rejects a token that declares an unsupported algorithm', async () => {
    const forged = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, {
      algorithm: 'HS512',
      expiresIn: '1h',
    });

    const res = await withToken(forged);
    expect(res.status).toBe(401);
  });

  it('the token header cannot dictate how it is verified', async () => {
    // Even signed with the right key, a different declared algorithm is
    // refused — the server decides, not the token.
    const hs384 = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, {
      algorithm: 'HS384',
      expiresIn: '1h',
    });

    expect((await withToken(hs384)).status).toBe(401);
  });
});

describe('token rejection paths', () => {
  it('accepts a legitimate token (the happy path still works)', async () => {
    expect((await withToken(authed.token)).status).toBe(200);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    expect((await withToken(expired)).status).toBe(401);
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = authed.token.split('.');
    const swapped = Buffer.from(JSON.stringify({ sub: '64b7f1f1f1f1f1f1f1f1f1bb' })).toString('base64url');
    expect((await withToken(`${header}.${swapped}.${signature}`)).status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ sub: authed.id }, 'an-attackers-own-secret-long-enough-here', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });
    expect((await withToken(forged)).status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    expect((await withToken('not-a-jwt-at-all')).status).toBe(401);
  });

  it('rejects a token whose user has been deleted', async () => {
    await User.deleteOne({ _id: authed.userId });
    expect((await withToken(authed.token)).status).toBe(401);
  });

  it('the token payload carries only the subject and timing claims', async () => {
    const payload = JSON.parse(Buffer.from(authed.token.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
  });

  it('the token carries an explicit expiry', async () => {
    const payload = JSON.parse(Buffer.from(authed.token.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(3600);
  });
});

describe('Authorization header format', () => {
  async function withRawHeader(value) {
    const req = request(app).get('/api/tasks');
    if (value !== undefined) req.set('Authorization', value);
    return req;
  }

  it.each([
    ['missing entirely', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['scheme with no token', 'Bearer'],
    ['scheme with only spaces after it', 'Bearer    '],
    ['a bare token with no scheme', 'sometokenvalue'],
    ['the wrong scheme', 'Basic sometokenvalue'],
    ['a token containing a space', 'Bearer part1 part2'],
  ])('rejects a header that is %s', async (_label, value) => {
    const res = await withRawHeader(value);
    expect(res.status).toBe(401);
  });

  it('rejects two credentials supplied in one header', async () => {
    // Duplicate Authorization headers are joined by the HTTP layer into
    // "Bearer AAA, Bearer BBB". Refusing the shape makes the rejection
    // deliberate rather than an accidental signature failure.
    const res = await withRawHeader(`Bearer ${authed.token}, Bearer ${authed.token}`);
    expect(res.status).toBe(401);
  });

  it('rejects a comma-joined token with no space (reaches the comma guard)', async () => {
    // "Bearer a,b" survives the two-part shape check, so the comma guard is
    // what refuses it — distinct from the ", " case above, which is rejected
    // earlier for having four whitespace-separated parts.
    const res = await withRawHeader(`Bearer ${authed.token},${authed.token}`);
    expect(res.status).toBe(401);
  });

  it('accepts extra whitespace between scheme and token', async () => {
    const res = await withRawHeader(`Bearer    ${authed.token}`);
    expect(res.status).toBe(200);
  });

  it('accepts a lowercase scheme', async () => {
    const res = await withRawHeader(`bearer ${authed.token}`);
    expect(res.status).toBe(200);
  });
});

describe('tokens never leak', () => {
  it('a rejected token is not echoed in the response', async () => {
    const res = await withToken('a-clearly-identifiable-bad-token-value');
    expect(JSON.stringify(res.body)).not.toContain('a-clearly-identifiable-bad-token-value');
  });

  it('a valid token is not echoed back in API responses', async () => {
    const res = await withToken(authed.token);
    expect(JSON.stringify(res.body)).not.toContain(authed.token);
  });

  it('the secret never appears in any response', async () => {
    const res = await withToken('bad-token');
    const everything = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(everything).not.toContain(process.env.JWT_SECRET);
  });

  it('auth failures stay generic across every distinct cause', async () => {
    const expired = jwt.sign({ sub: authed.id }, process.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1s',
    });
    const forged = jwt.sign({ sub: authed.id }, 'another-secret-that-is-long-enough-x', {
      algorithm: 'HS256',
      expiresIn: '1h',
    });

    const messages = [
      (await withToken(expired)).body.message,
      (await withToken(forged)).body.message,
      (await withToken('malformed')).body.message,
    ];

    expect(new Set(messages).size).toBe(1);
  });
});
