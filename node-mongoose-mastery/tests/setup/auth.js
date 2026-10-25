import request from 'supertest';
import app from '../../src/app.js';
import User from '../../src/models/user.model.js';
import { signToken } from '../../src/config/jwt.js';

// The password every seeded test user has, and a real bcrypt hash of it
// generated once at cost 12. Seeding the hash directly (instead of calling
// the register endpoint) is purely a speed decision: bcrypt at cost 12 costs
// ~200ms by design, and the ~300 task tests that merely need *some*
// authenticated user would otherwise add minutes to a suite that runs in
// seconds.
//
// This is a seeding shortcut, not a coverage gap. The real hashing path —
// register actually hashing, login actually comparing — is exercised
// end-to-end by tests/integration/auth.register.test.js and
// auth.login.test.js, which go through the HTTP endpoints with real bcrypt.
export const TEST_PASSWORD = 'test-password-123';
const TEST_PASSWORD_HASH = '$2b$12$y5qRH275CXYPVtHYXohT2OXT9BMNpGkNzo.yyQtWHZnfVcjYJmy2e';

let emailCounter = 0;

// Unique per call so two users created in the same test never collide on the
// unique email index.
export function uniqueEmail(prefix = 'user') {
  emailCounter += 1;
  return `${prefix}-${emailCounter}-${Date.now()}@example.com`;
}

export function buildRegisterPayload(overrides = {}) {
  return {
    name: 'Test User',
    email: uniqueEmail(),
    password: TEST_PASSWORD,
    ...overrides,
  };
}

// Wraps supertest so every request carries the Authorization header. The
// returned object exposes the same .get/.post/.patch/.delete surface the
// Phase 4 tests already call, so those tests only had to swap `request(app)`
// for `api` — their assertions are untouched.
export function authedRequest(token) {
  const withAuth = (req) => req.set('Authorization', `Bearer ${token}`);
  return {
    get: (url) => withAuth(request(app).get(url)),
    post: (url) => withAuth(request(app).post(url)),
    patch: (url) => withAuth(request(app).patch(url)),
    put: (url) => withAuth(request(app).put(url)),
    delete: (url) => withAuth(request(app).delete(url)),
  };
}

// Creates a user straight through the model and signs a token for it — the
// fast path described above. Returns everything a test might need: the
// Mongoose document, its id as both a string and an ObjectId (seeders need
// the ObjectId, assertions need the string), a valid token, and a ready-made
// authenticated request helper.
export async function createTestUser(overrides = {}) {
  const user = await User.create({
    name: 'Test User',
    email: uniqueEmail(),
    passwordHash: TEST_PASSWORD_HASH,
    ...overrides,
  });

  const token = signToken(user._id);

  return {
    user,
    userId: user._id,
    id: user._id.toString(),
    email: user.email,
    token,
    api: authedRequest(token),
  };
}

// Registers and logs in through the real HTTP endpoints, with real bcrypt.
// Used by the auth integration tests where exercising the genuine path is
// the whole point.
export async function registerAndLogin(overrides = {}) {
  const payload = buildRegisterPayload(overrides);

  const registerResponse = await request(app).post('/api/auth/register').send(payload);
  const loginResponse = await request(app)
    .post('/api/auth/login')
    .send({ email: payload.email, password: payload.password });

  const token = loginResponse.body?.data?.token;

  return {
    payload,
    registerResponse,
    loginResponse,
    token,
    api: token ? authedRequest(token) : null,
  };
}
