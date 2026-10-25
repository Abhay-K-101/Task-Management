import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import bcrypt from 'bcrypt';
import userRepository from '../../src/repositories/user.repository.js';
import authService from '../../src/services/auth.service.js';

// The repository is mocked; bcrypt and the JWT signer are real. Hashing is
// the behaviour under test, so faking it would hollow out the file — these
// tests take a little longer than the other unit tests precisely because
// real bcrypt is doing real work.
vi.mock('../../src/repositories/user.repository.js', () => ({
  default: {
    isValidId: vi.fn(),
    create: vi.fn(),
    findByEmail: vi.fn(),
    findByEmailWithPasswordHash: vi.fn(),
    findById: vi.fn(),
  },
}));

const USER_ID = '64b7f1f1f1f1f1f1f1f1f1aa';

function fakeUserDoc(overrides = {}) {
  return {
    _id: { toString: () => USER_ID },
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-long-enough-for-policy';
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('register', () => {
  it('hashes the password before handing it to the repository', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'a-real-password',
    });

    const [persisted] = userRepository.create.mock.calls[0];
    expect(persisted.passwordHash).toEqual(expect.any(String));
    expect(persisted.passwordHash).not.toBe('a-real-password');
    expect(persisted.passwordHash).toMatch(/^\$2[aby]\$/);
  });

  it('never passes a plaintext password field to the repository', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'a-real-password',
    });

    const [persisted] = userRepository.create.mock.calls[0];
    expect(persisted).not.toHaveProperty('password');
    expect(JSON.stringify(persisted)).not.toContain('a-real-password');
  });

  it('produces a hash that genuinely verifies against the original password', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'a-real-password',
    });

    const [persisted] = userRepository.create.mock.calls[0];
    expect(await bcrypt.compare('a-real-password', persisted.passwordHash)).toBe(true);
    expect(await bcrypt.compare('a-different-password', persisted.passwordHash)).toBe(false);
  });

  it('salts: the same password hashed twice produces two different hashes', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    const payload = { name: 'Ada Lovelace', email: 'a@example.com', password: 'identical' };
    await authService.register(payload);
    await authService.register({ ...payload, email: 'b@example.com' });

    const [first] = userRepository.create.mock.calls[0];
    const [second] = userRepository.create.mock.calls[1];
    expect(first.passwordHash).not.toBe(second.passwordHash);
  });

  it('uses the configured bcrypt cost factor', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({ name: 'Ada', email: 'a@example.com', password: 'a-password' });

    const [persisted] = userRepository.create.mock.calls[0];
    const cost = String(authService.BCRYPT_COST).padStart(2, '0');
    expect(persisted.passwordHash.startsWith(`$2b$${cost}$`)).toBe(true);
  });

  it('normalises the email to lowercase and trims it', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({
      name: 'Ada',
      email: '  Ada@Example.COM  ',
      password: 'a-password',
    });

    expect(userRepository.findByEmail).toHaveBeenCalledWith('ada@example.com');
    expect(userRepository.create.mock.calls[0][0].email).toBe('ada@example.com');
  });

  it('trims the name', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc());

    await authService.register({ name: '  Ada  ', email: 'a@example.com', password: 'a-password' });

    expect(userRepository.create.mock.calls[0][0].name).toBe('Ada');
  });

  it('rejects a duplicate email with 409 and never writes', async () => {
    userRepository.findByEmail.mockResolvedValue(fakeUserDoc());

    await expect(
      authService.register({ name: 'Ada', email: 'ada@example.com', password: 'a-password' })
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(userRepository.create).not.toHaveBeenCalled();
  });

  it('converts a duplicate-key race into the same 409', async () => {
    // Two simultaneous registrations can both pass the existence check; the
    // unique index is what actually stops the second one.
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));

    await expect(
      authService.register({ name: 'Ada', email: 'ada@example.com', password: 'a-password' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets an unexpected repository error propagate unchanged', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    const failure = new Error('database is down');
    userRepository.create.mockRejectedValue(failure);

    await expect(
      authService.register({ name: 'Ada', email: 'ada@example.com', password: 'a-password' })
    ).rejects.toBe(failure);
  });

  it('returns a public user containing no hash and no password', async () => {
    userRepository.findByEmail.mockResolvedValue(null);
    userRepository.create.mockResolvedValue(fakeUserDoc({ passwordHash: 'super-secret-hash' }));

    const result = await authService.register({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'a-password',
    });

    expect(result).toEqual({
      id: USER_ID,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(result)).not.toContain('super-secret-hash');
  });
});

describe('login', () => {
  async function userWithPassword(password) {
    return fakeUserDoc({ passwordHash: await bcrypt.hash(password, 4) });
  }

  it('returns a token and a public user for correct credentials', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    const result = await authService.login({ email: 'ada@example.com', password: 'right' });

    expect(result.token).toEqual(expect.any(String));
    expect(result.token.split('.')).toHaveLength(3);
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  it('asks the repository for the variant that includes the hash', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    await authService.login({ email: 'ada@example.com', password: 'right' });

    expect(userRepository.findByEmailWithPasswordHash).toHaveBeenCalledWith('ada@example.com');
  });

  it('normalises the email before looking it up', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    await authService.login({ email: '  Ada@Example.COM ', password: 'right' });

    expect(userRepository.findByEmailWithPasswordHash).toHaveBeenCalledWith('ada@example.com');
  });

  it('rejects a wrong password with 401', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    await expect(
      authService.login({ email: 'ada@example.com', password: 'wrong' })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects an unknown email with 401', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(null);

    await expect(
      authService.login({ email: 'nobody@example.com', password: 'anything' })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('returns the identical message for an unknown email and a wrong password', async () => {
    // Different messages would turn login into a free "does this address
    // have an account here?" oracle.
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(null);
    const unknownEmailError = await authService
      .login({ email: 'nobody@example.com', password: 'anything' })
      .catch((error) => error);

    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));
    const wrongPasswordError = await authService
      .login({ email: 'ada@example.com', password: 'wrong' })
      .catch((error) => error);

    expect(unknownEmailError.message).toBe(wrongPasswordError.message);
    expect(unknownEmailError.statusCode).toBe(wrongPasswordError.statusCode);
    // The shared wording names both fields together on purpose. What must
    // never appear is a message that singles one out ("no account with that
    // email", "incorrect password"), because that is what identifies which
    // half was wrong.
    expect(unknownEmailError.message).toBe('Invalid email or password');
    expect(unknownEmailError.message).not.toMatch(/no account|not found|unknown|incorrect password/i);
  });

  it('still performs a bcrypt comparison when the email is unknown', async () => {
    // Returning early would make "unknown email" measurably faster than
    // "known email, wrong password", re-creating the enumeration oracle
    // that the shared message closes.
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(null);
    const compareSpy = vi.spyOn(bcrypt, 'compare');

    await authService.login({ email: 'nobody@example.com', password: 'anything' }).catch(() => {});

    expect(compareSpy).toHaveBeenCalledTimes(1);
    compareSpy.mockRestore();
  });

  it('issues a token whose subject is the user id', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    const { token } = await authService.login({ email: 'ada@example.com', password: 'right' });

    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe(USER_ID);
  });

  it('issues a token that carries no password hash or email', async () => {
    const user = await userWithPassword('right');
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(user);

    const { token } = await authService.login({ email: 'ada@example.com', password: 'right' });

    // A JWT is signed, not encrypted — anything in the payload is readable
    // by whoever holds the token.
    const rawPayload = Buffer.from(token.split('.')[1], 'base64url').toString();
    expect(rawPayload).not.toContain(user.passwordHash);
    expect(rawPayload).not.toContain('ada@example.com');
  });

  it('sets an expiry claim on the token', async () => {
    userRepository.findByEmailWithPasswordHash.mockResolvedValue(await userWithPassword('right'));

    const { token } = await authService.login({ email: 'ada@example.com', password: 'right' });

    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.exp).toEqual(expect.any(Number));
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});

describe('getCurrentUser', () => {
  it('returns the public user shape', async () => {
    userRepository.findById.mockResolvedValue(fakeUserDoc({ passwordHash: 'secret-hash' }));

    const result = await authService.getCurrentUser(USER_ID);

    expect(result).toMatchObject({ id: USER_ID, name: 'Ada Lovelace', email: 'ada@example.com' });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('throws 401 when the account behind a valid token no longer exists', async () => {
    userRepository.findById.mockResolvedValue(null);

    await expect(authService.getCurrentUser(USER_ID)).rejects.toMatchObject({ statusCode: 401 });
  });
});
