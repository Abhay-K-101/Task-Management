import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notFoundHandler, errorHandler } from '../../src/middleware/error.middleware.js';

// The error handler is the single place every failure in the application
// funnels through, so its branches are worth exercising directly rather than
// only incidentally via HTTP. One branch in particular — the Mongoose
// ValidationError path — became unreachable through the API in Phase 6,
// because the strict validators now reject bad input before it can reach the
// schema. It remains as defence in depth for any future code path that writes
// to Mongoose without passing a validator first, so it is tested here.

function buildRes() {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function run(err) {
  const res = buildRes();
  const next = vi.fn();
  errorHandler(err, {}, res, next);
  return {
    status: res.status.mock.calls[0]?.[0],
    body: res.json.mock.calls[0]?.[0],
    next,
  };
}

let consoleSpy;

beforeEach(() => {
  // The 500 branch logs a stack server-side; keep it out of the test output
  // without suppressing the assertion that it happened.
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notFoundHandler', () => {
  it('answers 404 with the standard envelope', () => {
    const res = buildRes();
    notFoundHandler({}, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Route not found' });
  });
});

describe('body-parser failures are kept distinct', () => {
  it('malformed JSON becomes 400', () => {
    const { status, body } = run({ type: 'entity.parse.failed', message: 'Unexpected token' });
    expect(status).toBe(400);
    expect(body).toEqual({ success: false, message: 'Malformed JSON in request body' });
  });

  it('an oversized body becomes 413', () => {
    const { status, body } = run({ type: 'entity.too.large', message: 'request entity too large' });
    expect(status).toBe(413);
    expect(body).toEqual({ success: false, message: 'Request body is too large' });
  });

  it('the two produce different messages', () => {
    const malformed = run({ type: 'entity.parse.failed' }).body.message;
    const oversized = run({ type: 'entity.too.large' }).body.message;
    expect(malformed).not.toBe(oversized);
  });

  it('neither echoes the parser internals back to the client', () => {
    const { body } = run({
      type: 'entity.too.large',
      message: 'request entity too large',
      limit: 16384,
      length: 99999,
      body: 'RAWBODYCONTENT',
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('RAWBODYCONTENT');
    expect(raw).not.toContain('16384');
    expect(raw).not.toContain('entity.too.large');
  });
});

describe('Mongoose ValidationError (defence in depth)', () => {
  it('becomes a 400 carrying the validation message', () => {
    // Reached only if something writes to the schema without a validator in
    // front of it. The strict middleware makes that impossible today, which is
    // exactly why this is asserted directly instead of through a request.
    const err = new Error('Task validation failed: title: Path `title` is required.');
    err.name = 'ValidationError';

    const { status, body } = run(err);

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      message: 'Task validation failed: title: Path `title` is required.',
    });
  });

  it('is preferred over the generic 500 branch', () => {
    const err = new Error('User validation failed: email: invalid');
    err.name = 'ValidationError';
    expect(run(err).status).toBe(400);
  });
});

describe('errors tagged with a statusCode', () => {
  it.each([
    [400, 'Invalid task id'],
    [401, 'Invalid or expired token'],
    [404, 'Task not found'],
    [409, 'An account with that email already exists'],
  ])('passes %i through with its message', (statusCode, message) => {
    const { status, body } = run(Object.assign(new Error(message), { statusCode }));
    expect(status).toBe(statusCode);
    expect(body).toEqual({ success: false, message });
  });
});

describe('anything unexpected', () => {
  it('becomes a generic 500', () => {
    const { status, body } = run(new Error('something internal exploded'));
    expect(status).toBe(500);
    expect(body).toEqual({ success: false, message: 'Something went wrong' });
  });

  it('never leaks the original message or stack to the client', () => {
    const err = new Error('connection to mongodb://admin:hunter2@host/db failed');
    const { body } = run(err);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('mongodb://');
  });

  it('logs the stack server-side so the failure is still diagnosable', () => {
    run(new Error('internal'));
    expect(consoleSpy).toHaveBeenCalled();
  });
});
