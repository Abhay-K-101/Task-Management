import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCorsOptions } from '../../src/middleware/cors.middleware.js';
import { ALLOWED_HTTP_METHODS, ALLOWED_REQUEST_HEADERS } from '../../src/config/security.js';

// The origin callback is the entire CORS decision, so it is tested directly
// rather than through HTTP. No Express, no network.

let savedOrigins;

beforeEach(() => {
  savedOrigins = process.env.ALLOWED_ORIGINS;
});

afterEach(() => {
  if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = savedOrigins;
});

// Runs the origin callback synchronously and returns the allow/deny decision.
function decide(requestOrigin) {
  const { origin } = buildCorsOptions();
  let result;
  let error;
  origin(requestOrigin, (err, allowed) => {
    error = err;
    result = allowed;
  });
  return { error, allowed: result };
}

describe('CORS origin decisions', () => {
  it('allows a configured origin', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(decide('http://localhost:5173')).toEqual({ error: null, allowed: true });
  });

  it('allows each of several configured origins', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,http://localhost:5173';
    expect(decide('http://localhost:3000').allowed).toBe(true);
    expect(decide('http://localhost:5173').allowed).toBe(true);
  });

  it('denies an origin that is not configured', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(decide('http://evil.test')).toEqual({ error: null, allowed: false });
  });

  it('denies every origin when the allow-list is empty', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(decide('http://localhost:5173').allowed).toBe(false);
  });

  it('denies every origin when the allow-list is malformed whitespace', () => {
    process.env.ALLOWED_ORIGINS = '  ,  ,';
    expect(decide('http://localhost:5173').allowed).toBe(false);
  });

  it('never signals an error, so a disallowed origin cannot become a 500', () => {
    // Throwing here is a common mistake: it turns a routine client-side policy
    // decision into a server fault and an alarming log entry.
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(decide('http://evil.test').error).toBeNull();
  });

  it('matches origins exactly, not by prefix or suffix', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(decide('http://localhost:51730').allowed).toBe(false);
    expect(decide('http://localhost:5173.evil.test').allowed).toBe(false);
    expect(decide('http://evil.test?x=http://localhost:5173').allowed).toBe(false);
  });

  it('distinguishes scheme and port', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.test';
    expect(decide('http://app.test').allowed).toBe(false);
    expect(decide('https://app.test:8443').allowed).toBe(false);
    expect(decide('https://app.test').allowed).toBe(true);
  });

  it('allows requests with no Origin header (curl, Supertest, server-to-server)', () => {
    // Documented policy. CORS is a browser mechanism; a client that can omit
    // an Origin header can equally forge one, so blocking these would break
    // every non-browser caller while adding no security. The real gate for
    // them is the JWT.
    delete process.env.ALLOWED_ORIGINS;
    expect(decide(undefined).allowed).toBe(true);
    expect(decide('').allowed).toBe(true);
  });
});

describe('CORS options', () => {
  it('permits exactly the methods this API serves', () => {
    expect(buildCorsOptions().methods).toEqual(ALLOWED_HTTP_METHODS);
    expect(buildCorsOptions().methods).toContain('OPTIONS');
    expect(buildCorsOptions().methods).not.toContain('PUT');
  });

  it('permits Content-Type and Authorization', () => {
    expect(buildCorsOptions().allowedHeaders).toEqual(ALLOWED_REQUEST_HEADERS);
    expect(buildCorsOptions().allowedHeaders).toContain('Authorization');
  });

  it('does not enable credentials, matching the bearer-token architecture', () => {
    // Credentials mode exists for cookies and HTTP auth. This API authenticates
    // with an Authorization header the client sets explicitly, so enabling it
    // would grant browsers permission they do not need.
    expect(buildCorsOptions().credentials).toBe(false);
  });

  it('answers preflight with 204', () => {
    expect(buildCorsOptions().optionsSuccessStatus).toBe(204);
  });

  it('never configures a wildcard origin', () => {
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(buildCorsOptions().origin).not.toBe('*');
    expect(typeof buildCorsOptions().origin).toBe('function');
  });
});
