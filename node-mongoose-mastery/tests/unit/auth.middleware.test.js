import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import userRepository from '../../src/repositories/user.repository.js';
import { requireAuth } from '../../src/middleware/auth.middleware.js';
import { signToken } from '../../src/config/jwt.js';

// The user repository is mocked, so this file needs no database. JWT signing
// and verification are deliberately NOT mocked — the whole point of this
// middleware is that it rejects tokens a real verifier rejects, so faking
// the verifier would prove nothing.
vi.mock('../../src/repositories/user.repository.js', () => ({
  default: {
    isValidId: vi.fn(),
    findById: vi.fn(),
  },
}));

const USER_ID = '64b7f1f1f1f1f1f1f1f1f1aa';
const FAKE_USER = {
  _id: { toString: () => USER_ID },
  name: 'Ada Lovelace',
  email: 'ada@example.com',
};

beforeAll(() => {
  // globalSetup provides this for the whole run, but this file is also
  // meaningful on its own, so it guarantees its own secret.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-long-enough-for-policy';
});

beforeEach(() => {
  vi.clearAllMocks();
  userRepository.isValidId.mockReturnValue(true);
  userRepository.findById.mockResolvedValue(FAKE_USER);
});

function buildRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

async function run(authorization) {
  const req = { headers: authorization === undefined ? {} : { authorization } };
  const res = buildRes();
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
}

function expectUnauthorized(res, next) {
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
  const [body] = res.json.mock.calls[0];
  expect(body.success).toBe(false);
  return body;
}

describe('requireAuth — accepting a valid token', () => {
  it('calls next() exactly once for a valid Bearer token', async () => {
    const { res, next } = await run(`Bearer ${signToken(USER_ID)}`);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('attaches a plain user object to the request', async () => {
    const { req } = await run(`Bearer ${signToken(USER_ID)}`);
    expect(req.user).toEqual({ id: USER_ID, name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('never attaches a password hash to the request', async () => {
    userRepository.findById.mockResolvedValue({ ...FAKE_USER, passwordHash: 'should-not-leak' });
    const { req } = await run(`Bearer ${signToken(USER_ID)}`);
    expect(req.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(req.user)).not.toContain('should-not-leak');
  });

  it('looks the user up by the id inside the token', async () => {
    await run(`Bearer ${signToken(USER_ID)}`);
    expect(userRepository.findById).toHaveBeenCalledWith(USER_ID);
  });

  it('accepts a lowercase "bearer" scheme', async () => {
    const { next } = await run(`bearer ${signToken(USER_ID)}`);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('tolerates extra whitespace between the scheme and the token', async () => {
    const { next } = await run(`Bearer    ${signToken(USER_ID)}`);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('requireAuth — rejecting bad credentials', () => {
  it('rejects a missing Authorization header', async () => {
    const { res, next } = await run(undefined);
    expectUnauthorized(res, next);
  });

  it('rejects an empty Authorization header', async () => {
    const { res, next } = await run('');
    expectUnauthorized(res, next);
  });

  it('rejects a header with no Bearer scheme', async () => {
    const { res, next } = await run(signToken(USER_ID));
    expectUnauthorized(res, next);
  });

  it('rejects a non-Bearer scheme', async () => {
    const { res, next } = await run(`Basic ${signToken(USER_ID)}`);
    expectUnauthorized(res, next);
  });

  it('rejects "Bearer" with no token', async () => {
    const { res, next } = await run('Bearer');
    expectUnauthorized(res, next);
  });

  it('rejects "Bearer " with only whitespace after it', async () => {
    const { res, next } = await run('Bearer    ');
    expectUnauthorized(res, next);
  });

  it('rejects a malformed token', async () => {
    const { res, next } = await run('Bearer not-a-jwt-at-all');
    expectUnauthorized(res, next);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ sub: USER_ID }, 'an-attackers-own-secret', { expiresIn: '1h' });
    const { res, next } = await run(`Bearer ${forged}`);
    expectUnauthorized(res, next);
  });

  it('rejects a token whose payload has been tampered with', async () => {
    // Re-encode the payload with a different subject but keep the original
    // signature — the classic "just edit the middle section" attempt.
    const [header, , signature] = signToken(USER_ID).split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: '64b7f1f1f1f1f1f1f1f1f1bb' })
    ).toString('base64url');
    const { res, next } = await run(`Bearer ${header}.${tamperedPayload}.${signature}`);
    expectUnauthorized(res, next);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ sub: USER_ID }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const { res, next } = await run(`Bearer ${expired}`);
    expectUnauthorized(res, next);
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it('rejects the "none" algorithm', async () => {
    // A classic JWT attack: strip the signature and claim the token needs
    // none. jsonwebtoken must refuse it rather than trusting the payload.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: USER_ID })).toString('base64url');
    const { res, next } = await run(`Bearer ${header}.${payload}.`);
    expectUnauthorized(res, next);
  });

  it('rejects a valid token whose user no longer exists', async () => {
    userRepository.findById.mockResolvedValue(null);
    const { res, next } = await run(`Bearer ${signToken(USER_ID)}`);
    expectUnauthorized(res, next);
  });

  it('rejects a token whose subject is not a valid object id', async () => {
    userRepository.isValidId.mockReturnValue(false);
    const { res, next } = await run(`Bearer ${signToken('not-an-object-id')}`);
    expectUnauthorized(res, next);
    expect(userRepository.findById).not.toHaveBeenCalled();
  });

  it('answers every distinct failure cause with one identical message', async () => {
    // The security property is indistinguishability: an attacker probing the
    // endpoint must not be able to tell a forged token from an expired one,
    // or either from a token whose account has since been deleted. The shared
    // wording ("Invalid or expired token") deliberately covers all of them
    // at once rather than reporting which actually applied.
    const expired = jwt.sign({ sub: USER_ID }, process.env.JWT_SECRET, { expiresIn: '-1s' });
    const forged = jwt.sign({ sub: USER_ID }, 'an-attackers-own-secret', { expiresIn: '1h' });
    const malformed = 'not-a-jwt-at-all';

    const expiredRun = await run(`Bearer ${expired}`);
    const forgedRun = await run(`Bearer ${forged}`);
    const malformedRun = await run(`Bearer ${malformed}`);

    userRepository.findById.mockResolvedValue(null);
    const deletedUserRun = await run(`Bearer ${signToken(USER_ID)}`);

    const messages = [expiredRun, forgedRun, malformedRun, deletedUserRun].map((result) => {
      const body = expectUnauthorized(result.res, result.next);
      return body.message;
    });

    expect(new Set(messages).size).toBe(1);
    // And it must never name an internal cause.
    expect(messages[0]).not.toMatch(/signature|secret|database|deleted|no such/i);
  });
});

describe('requireAuth — server faults are not disguised as auth failures', () => {
  it('forwards an unexpected repository error to next() instead of returning 401', async () => {
    const failure = new Error('database is down');
    userRepository.findById.mockRejectedValue(failure);

    const { res, next } = await run(`Bearer ${signToken(USER_ID)}`);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(failure);
  });

  it('forwards a missing-JWT_SECRET configuration error rather than reporting 401', async () => {
    const token = signToken(USER_ID);
    const originalSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const { res, next } = await run(`Bearer ${token}`);
      // A broken deployment must look like a server fault (500), not like
      // every user suddenly having bad credentials.
      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(next.mock.calls[0][0].statusCode).toBeUndefined();
    } finally {
      process.env.JWT_SECRET = originalSecret;
    }
  });
});
