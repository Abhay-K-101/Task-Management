import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/app.js';
import {
  connectTestDatabase,
  clearTestDatabase,
  disconnectTestDatabase,
} from '../setup/database.js';
import { resetRateLimiters } from '../../src/middleware/rate-limit.middleware.js';
import { createTestUser } from '../setup/auth.js';

// CORS is enforced by browsers, so what the server controls is exactly one
// thing: whether it returns an Access-Control-Allow-Origin header naming the
// caller's origin. These tests assert that header, because that header is the
// entire decision.

const ALLOWED = 'http://localhost:5173';
const SECOND_ALLOWED = 'http://localhost:3000';
const DISALLOWED = 'http://evil.test';

let savedOrigins;
let authed;

beforeAll(async () => {
  await connectTestDatabase();
});

beforeEach(async () => {
  // The real app's limiters are process-wide singletons. Clearing them
  // here means no test file can inherit counters from another.
  resetRateLimiters();
  await clearTestDatabase();
  savedOrigins = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = `${SECOND_ALLOWED},${ALLOWED}`;
  authed = await createTestUser();
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = savedOrigins;
});

afterAll(async () => {
  await disconnectTestDatabase();
});

describe('allowed origins', () => {
  it('echoes Access-Control-Allow-Origin for a configured origin', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('allows each entry when several origins are configured', async () => {
    for (const origin of [ALLOWED, SECOND_ALLOWED]) {
      const res = await request(app)
        .get('/api/tasks')
        .set('Origin', origin)
        .set('Authorization', `Bearer ${authed.token}`);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('parses an allow-list containing whitespace and empty entries', async () => {
    process.env.ALLOWED_ORIGINS = `  ${ALLOWED} , , ${SECOND_ALLOWED} ,`;
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });
});

describe('disallowed origins', () => {
  it('omits Access-Control-Allow-Origin for an unconfigured origin', async () => {
    // The browser sees no permission and refuses to expose the response to the
    // calling page. That is the real rejection; the server does not need to
    // invent a status code for it.
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', DISALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not turn a disallowed origin into a 500', async () => {
    // A common implementation mistake is to call the CORS callback with an
    // Error, which reaches the error handler and becomes a server fault for
    // what is really a routine client-side policy decision.
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', DISALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.status).not.toBe(500);
  });

  it('never reveals the configured allow-list', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', DISALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    const everything = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(everything).not.toContain(ALLOWED);
    expect(everything).not.toContain(SECOND_ALLOWED);
    expect(everything).not.toContain('ALLOWED_ORIGINS');
  });

  it('every disallowed origin looks identical, so the list cannot be mapped', async () => {
    const a = await request(app).get('/api/tasks').set('Origin', 'http://a.evil')
      .set('Authorization', `Bearer ${authed.token}`);
    const b = await request(app).get('/api/tasks').set('Origin', 'http://b.evil')
      .set('Authorization', `Bearer ${authed.token}`);

    expect(a.status).toBe(b.status);
    expect(a.headers['access-control-allow-origin']).toBe(b.headers['access-control-allow-origin']);
  });

  it('an empty allow-list denies every browser origin', async () => {
    delete process.env.ALLOWED_ORIGINS;
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('requests with no Origin header', () => {
  it('are allowed — curl, Supertest and server-to-server keep working', async () => {
    // Documented policy. Every other test in this repository relies on it.
    const res = await authed.api.get('/api/tasks');
    expect(res.status).toBe(200);
  });

  it('still require authentication — CORS is not authorization', async () => {
    // The point worth internalising: skipping CORS does not skip the auth
    // check. A non-browser client gets past CORS trivially and is then stopped
    // by the bearer token, which is the control that actually matters.
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('a disallowed origin does not stop a non-browser client with a valid token', async () => {
    // Honest framing: CORS constrains browsers. curl can send any Origin it
    // likes and still read the response, because nothing is enforcing the
    // policy on its end.
    const res = await request(app)
      .get('/api/tasks')
      .set('Origin', DISALLOWED)
      .set('Authorization', `Bearer ${authed.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('preflight (OPTIONS)', () => {
  it('answers a preflight from an allowed origin', async () => {
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('advertises the Authorization header as permitted', async () => {
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization');

    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/i);
    expect(res.headers['access-control-allow-headers']).toMatch(/Content-Type/i);
  });

  it('advertises the methods the API actually serves', async () => {
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'PATCH');

    const allowed = res.headers['access-control-allow-methods'];
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(allowed).toMatch(new RegExp(method));
    }
  });

  it('does not permit credentials, matching the bearer-token design', async () => {
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('a preflight from a disallowed origin gets no allow-origin header', async () => {
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', DISALLOWED)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight never requires a token', async () => {
    // A browser sends preflight without credentials by design, so demanding
    // auth here would break every legitimate cross-origin call.
    const res = await request(app)
      .options('/api/tasks')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).not.toBe(401);
  });
});
