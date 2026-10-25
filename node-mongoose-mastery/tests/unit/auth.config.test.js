import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import User from '../../src/models/user.model.js';
import {
  signToken,
  verifyToken,
  assertJwtSecretConfigured,
  DEFAULT_EXPIRES_IN,
} from '../../src/config/jwt.js';

// No database and no HTTP here. A Mongoose document can be constructed
// without a connection, which is enough to prove how it serialises.

const USER_ID = '64b7f1f1f1f1f1f1f1f1f1aa';

let originalSecret;
let originalExpiresIn;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  originalExpiresIn = process.env.JWT_EXPIRES_IN;
  process.env.JWT_SECRET = 'config-test-secret-long-enough-for-policy';
  delete process.env.JWT_EXPIRES_IN;
});

afterEach(() => {
  // Restore whatever globalSetup put there, so no other file is affected.
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
  if (originalExpiresIn === undefined) delete process.env.JWT_EXPIRES_IN;
  else process.env.JWT_EXPIRES_IN = originalExpiresIn;
});

describe('jwt config — signing and verifying', () => {
  it('signs a token whose subject is the user id', () => {
    const decoded = jwt.decode(signToken(USER_ID));
    expect(decoded.sub).toBe(USER_ID);
  });

  it('round-trips: a signed token verifies with the same secret', () => {
    const payload = verifyToken(signToken(USER_ID));
    expect(payload.sub).toBe(USER_ID);
  });

  it('accepts an ObjectId-like value and stores it as a string', () => {
    const objectIdLike = { toString: () => USER_ID };
    expect(jwt.decode(signToken(objectIdLike)).sub).toBe(USER_ID);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signToken(USER_ID);
    process.env.JWT_SECRET = 'a-completely-different-secret-long-enough';
    expect(() => verifyToken(token)).toThrow();
  });

  it('puts nothing but sub/iat/exp in the payload', () => {
    // A JWT is readable by anyone holding it, so the payload is kept to the
    // minimum needed to identify the user.
    const decoded = jwt.decode(signToken(USER_ID));
    expect(Object.keys(decoded).sort()).toEqual(['exp', 'iat', 'sub']);
  });
});

describe('jwt config — expiry', () => {
  it('defaults to the documented 1 hour lifetime', () => {
    expect(DEFAULT_EXPIRES_IN).toBe('1h');
    const decoded = jwt.decode(signToken(USER_ID));
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it('honours a configured JWT_EXPIRES_IN', () => {
    process.env.JWT_EXPIRES_IN = '15m';
    const decoded = jwt.decode(signToken(USER_ID));
    expect(decoded.exp - decoded.iat).toBe(900);
  });

  it('trims a configured value', () => {
    process.env.JWT_EXPIRES_IN = '  30m  ';
    const decoded = jwt.decode(signToken(USER_ID));
    expect(decoded.exp - decoded.iat).toBe(1800);
  });

  it('falls back to the default when the configured value is blank', () => {
    process.env.JWT_EXPIRES_IN = '   ';
    const decoded = jwt.decode(signToken(USER_ID));
    expect(decoded.exp - decoded.iat).toBe(3600);
  });

  it('produces a token that is already expired when configured negatively', () => {
    process.env.JWT_EXPIRES_IN = '-1s';
    expect(() => verifyToken(signToken(USER_ID))).toThrow(/expired/i);
  });
});

describe('jwt config — the secret is required, with no fallback', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('signing throws when JWT_SECRET is %s', (_label, value) => {
    if (value === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = value;

    expect(() => signToken(USER_ID)).toThrow(/JWT_SECRET/);
  });

  it('verifying throws when JWT_SECRET is missing', () => {
    const token = signToken(USER_ID);
    delete process.env.JWT_SECRET;
    expect(() => verifyToken(token)).toThrow(/JWT_SECRET/);
  });

  it('assertJwtSecretConfigured passes when a secret is set', () => {
    expect(() => assertJwtSecretConfigured()).not.toThrow();
  });

  it('assertJwtSecretConfigured throws when the secret is missing', () => {
    delete process.env.JWT_SECRET;
    expect(() => assertJwtSecretConfigured()).toThrow(/JWT_SECRET/);
  });

  it('the configuration error carries no statusCode, so it surfaces as a 500 not a 4xx', () => {
    delete process.env.JWT_SECRET;
    let thrown;
    try {
      signToken(USER_ID);
    } catch (error) {
      thrown = error;
    }
    // A misconfigured server must not be reported to clients as though they
    // sent something wrong.
    expect(thrown.statusCode).toBeUndefined();
  });

  it('never includes the secret value in the error message', () => {
    process.env.JWT_SECRET = '   ';
    let thrown;
    try {
      signToken(USER_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message).toBe('JWT_SECRET is not configured');
  });
});

describe('User model — toJSON never serialises the password hash', () => {
  it('drops passwordHash from toJSON output', () => {
    const user = new User({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      passwordHash: '$2b$12$aRealLookingHashValueXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    });

    const serialised = user.toJSON();

    expect(serialised).not.toHaveProperty('passwordHash');
    expect(serialised.name).toBe('Ada Lovelace');
  });

  it('drops passwordHash from JSON.stringify output', () => {
    // This is the layer that protects against an accidental res.json(userDoc)
    // anywhere in the codebase.
    const user = new User({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      passwordHash: '$2b$12$aRealLookingHashValueXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    });

    const raw = JSON.stringify(user);

    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('$2b$');
  });

  it('lowercases the email on assignment', () => {
    const user = new User({ name: 'Ada', email: '  Ada@Example.COM  ', passwordHash: 'x' });
    expect(user.email).toBe('ada@example.com');
  });

  it('trims the name on assignment', () => {
    const user = new User({ name: '  Ada  ', email: 'a@example.com', passwordHash: 'x' });
    expect(user.name).toBe('Ada');
  });
});
