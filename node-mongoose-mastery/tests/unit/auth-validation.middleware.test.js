import { describe, it, expect, vi } from 'vitest';
import {
  validateRegister,
  validateLogin,
} from '../../src/middleware/auth-validation.middleware.js';

// Same approach as task-validation.middleware.test.js: the middleware is
// called directly with minimal req/res/next doubles. No Express, no HTTP,
// no database, no bcrypt.

function buildRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function run(middleware, body) {
  const req = body === undefined ? {} : { body };
  const res = buildRes();
  const next = vi.fn();
  middleware(req, res, next);
  return { req, res, next };
}

const VALID_REGISTER = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'a-long-enough-password',
};

describe('validateRegister', () => {
  it('calls next() exactly once for a valid body', () => {
    const { res, next } = run(validateRegister, VALID_REGISTER);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not mutate req.body', () => {
    const body = { ...VALID_REGISTER, email: '  Ada@Example.COM  ' };
    const { req } = run(validateRegister, body);
    expect(req.body.email).toBe('  Ada@Example.COM  ');
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 42],
  ])('rejects a name that is %s', (_label, name) => {
    const { res, next } = run(validateRegister, { ...VALID_REGISTER, name });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    [2, false],
    [3, true],
    [100, true],
    [101, false],
  ])('a name of length %i is accepted: %s (boundary)', (length, shouldPass) => {
    const { res, next } = run(validateRegister, { ...VALID_REGISTER, name: 'a'.repeat(length) });
    if (shouldPass) {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it('rejects a whitespace-only name', () => {
    const { next } = run(validateRegister, { ...VALID_REGISTER, name: '     ' });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    'not-an-email',
    'missing-at.example.com',
    'no-domain@',
    '@no-local.com',
    'spaces in@example.com',
    'no-tld@example',
  ])('rejects the invalid email %j', (email) => {
    const { res, next } = run(validateRegister, { ...VALID_REGISTER, email });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each([
    'simple@example.com',
    'dotted.name@example.co.uk',
    'plus+tag@example.io',
  ])('accepts the valid email %j', (email) => {
    const { next } = run(validateRegister, { ...VALID_REGISTER, email });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts an email with surrounding whitespace (trimmed before matching)', () => {
    const { next } = run(validateRegister, { ...VALID_REGISTER, email: '  ada@example.com  ' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    [7, false],
    [8, true],
    [72, true],
    [73, false],
  ])('a password of length %i is accepted: %s (boundary)', (length, shouldPass) => {
    const { res, next } = run(validateRegister, { ...VALID_REGISTER, password: 'p'.repeat(length) });
    if (shouldPass) {
      expect(next).toHaveBeenCalledTimes(1);
    } else {
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    }
  });

  it.each([
    ['missing', undefined],
    ['a number', 12345678],
    ['null', null],
  ])('rejects a password that is %s', (_label, password) => {
    const { next } = run(validateRegister, { ...VALID_REGISTER, password });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not trim the password before measuring its length', () => {
    // Spaces are legitimate password characters; trimming them would both
    // weaken the password and make the stored hash depend on invisible
    // formatting.
    const { next } = run(validateRegister, { ...VALID_REGISTER, password: '  678901  ' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(['passwordHash', '_id', 'createdAt', 'role', 'owner'])(
    'rejects the unknown/internal field %j',
    (field) => {
      const { res, next } = run(validateRegister, { ...VALID_REGISTER, [field]: 'smuggled' });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      const [body] = res.json.mock.calls[0];
      expect(body.message).toContain(field);
    }
  );

  it('accumulates multiple errors into one 400 response', () => {
    const { res, next } = run(validateRegister, { name: 'ab', email: 'nope', password: 'short' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledTimes(1);
    const [body] = res.json.mock.calls[0];
    expect(body.message).toMatch(/name/i);
    expect(body.message).toMatch(/email/i);
    expect(body.message).toMatch(/password/i);
  });

  it('handles a missing body without throwing', () => {
    const res = buildRes();
    const next = vi.fn();
    expect(() => validateRegister({}, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('validateLogin', () => {
  it('calls next() exactly once for a valid body', () => {
    const { next } = run(validateLogin, { email: 'ada@example.com', password: 'anything' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not apply the registration password-length rule', () => {
    // A short password must reach bcrypt and fail as a credential, not be
    // rejected here — otherwise the endpoint leaks the password policy to
    // anonymous callers and locks out accounts made under an older rule.
    const { next } = run(validateLogin, { email: 'ada@example.com', password: 'short' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not validate the email format', () => {
    // Same reasoning: whether the address exists is bcrypt/database
    // territory, and a format complaint here would distinguish "not a
    // valid address" from "wrong credentials".
    const { next } = run(validateLogin, { email: 'not-an-email', password: 'anything' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing email', { password: 'anything' }],
    ['an empty email', { email: '', password: 'anything' }],
    ['a whitespace-only email', { email: '   ', password: 'anything' }],
    ['a non-string email', { email: 42, password: 'anything' }],
    ['a missing password', { email: 'ada@example.com' }],
    ['an empty password', { email: 'ada@example.com', password: '' }],
    ['a non-string password', { email: 'ada@example.com', password: 42 }],
  ])('rejects %s', (_label, body) => {
    const { res, next } = run(validateLogin, body);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(['name', 'passwordHash', '_id'])('rejects the unknown field %j', (field) => {
    const { res, next } = run(validateLogin, {
      email: 'ada@example.com',
      password: 'anything',
      [field]: 'smuggled',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('handles a missing body without throwing', () => {
    const res = buildRes();
    const next = vi.fn();
    expect(() => validateLogin({}, res, next)).not.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
});
