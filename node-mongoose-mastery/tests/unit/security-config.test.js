import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseAllowedOrigins,
  parsePositiveInteger,
  parseByteSize,
  getAllowedOrigins,
  getRateLimitConfig,
  getAuthRateLimitConfig,
  getJsonBodyLimitBytes,
  assertSecurityConfig,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  MIN_JWT_SECRET_LENGTH,
} from '../../src/config/security.js';

// Pure configuration parsing: no Express, no HTTP, no database. Every test
// that touches process.env restores it afterwards so nothing leaks into
// another test or another file.

const MANAGED_KEYS = [
  'ALLOWED_ORIGINS',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'AUTH_RATE_LIMIT_WINDOW_MS',
  'AUTH_RATE_LIMIT_MAX',
  'JSON_BODY_LIMIT',
];

let saved;

beforeEach(() => {
  saved = {};
  for (const key of MANAGED_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function clear(...keys) {
  for (const key of keys) delete process.env[key];
}

describe('parseAllowedOrigins', () => {
  it('parses a single origin', () => {
    expect(parseAllowedOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });

  it('parses multiple comma-separated origins', () => {
    expect(parseAllowedOrigins('http://localhost:3000,http://localhost:5173')).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
    ]);
  });

  it('trims surrounding whitespace around each entry', () => {
    expect(parseAllowedOrigins('  http://a.test , http://b.test  ')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('drops empty entries from trailing or doubled commas', () => {
    expect(parseAllowedOrigins('http://a.test,,http://b.test,')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('returns an empty list for a whitespace-only value', () => {
    expect(parseAllowedOrigins('   ,  , ')).toEqual([]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
  ])('returns an empty list for %s rather than throwing', (_label, value) => {
    expect(parseAllowedOrigins(value)).toEqual([]);
  });

  it('never invents a wildcard', () => {
    // A misconfigured or absent allow-list must mean "no browser origin is
    // permitted", never "every origin is permitted".
    expect(parseAllowedOrigins('')).toEqual([]);
    expect(parseAllowedOrigins(undefined)).not.toContain('*');
  });
});

describe('parsePositiveInteger', () => {
  it.each([['1', 1], ['300', 300], [42, 42]])('accepts %s', (input, expected) => {
    expect(parsePositiveInteger(input, 'FIELD')).toBe(expected);
  });

  it.each(['0', '-1', '1.5', 'abc', '', ' ', 'Infinity', 'NaN'])(
    'rejects %j',
    (input) => {
      expect(() => parsePositiveInteger(input, 'FIELD')).toThrow(/FIELD/);
    }
  );

  it('enforces a maximum when given one', () => {
    expect(() => parsePositiveInteger('101', 'FIELD', { min: 1, max: 100 })).toThrow(/FIELD/);
    expect(parsePositiveInteger('100', 'FIELD', { min: 1, max: 100 })).toBe(100);
  });

  it('names the offending variable in the message', () => {
    expect(() => parsePositiveInteger('nope', 'RATE_LIMIT_MAX')).toThrow(/RATE_LIMIT_MAX/);
  });

  it('carries no statusCode, so a config fault cannot masquerade as a client error', () => {
    let thrown;
    try {
      parsePositiveInteger('nope', 'FIELD');
    } catch (error) {
      thrown = error;
    }
    expect(thrown.statusCode).toBeUndefined();
  });
});

describe('parseByteSize', () => {
  it.each([
    ['16kb', 16 * 1024],
    ['1mb', 1024 * 1024],
    ['512b', 512],
    ['2048', 2048],
    ['1MB', 1024 * 1024],
    ['  16kb  ', 16 * 1024],
    [4096, 4096],
  ])('parses %j into %i bytes', (input, expected) => {
    expect(parseByteSize(input, 'JSON_BODY_LIMIT')).toBe(expected);
  });

  it.each(['', '   ', 'abc', '16gb', '16 kb', '-1kb', '0', '0kb', '1.5kb', null, undefined, {}])(
    'rejects %j',
    (input) => {
      expect(() => parseByteSize(input, 'JSON_BODY_LIMIT')).toThrow(/JSON_BODY_LIMIT/);
    }
  );

  it('always returns a number, never a string', () => {
    // express.json() accepts either, but handing it a number removes any
    // chance of the body parser reinterpreting a malformed string.
    expect(typeof parseByteSize('16kb', 'X')).toBe('number');
  });
});

describe('configuration accessors', () => {
  it('falls back to documented defaults when nothing is configured', () => {
    clear('RATE_LIMIT_WINDOW_MS', 'RATE_LIMIT_MAX', 'AUTH_RATE_LIMIT_MAX', 'JSON_BODY_LIMIT');
    expect(getRateLimitConfig()).toEqual({
      windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
      limit: DEFAULT_RATE_LIMIT_MAX,
    });
    expect(getAuthRateLimitConfig().limit).toBe(DEFAULT_AUTH_RATE_LIMIT_MAX);
    expect(getJsonBodyLimitBytes()).toBe(DEFAULT_JSON_BODY_LIMIT_BYTES);
  });

  it('honours configured values', () => {
    process.env.RATE_LIMIT_WINDOW_MS = '60000';
    process.env.RATE_LIMIT_MAX = '25';
    process.env.JSON_BODY_LIMIT = '8kb';
    expect(getRateLimitConfig()).toEqual({ windowMs: 60000, limit: 25 });
    expect(getJsonBodyLimitBytes()).toBe(8 * 1024);
  });

  it('reads ALLOWED_ORIGINS from the environment', () => {
    process.env.ALLOWED_ORIGINS = 'http://a.test, http://b.test';
    expect(getAllowedOrigins()).toEqual(['http://a.test', 'http://b.test']);
  });

  it('treats an absent ALLOWED_ORIGINS as an empty allow-list', () => {
    clear('ALLOWED_ORIGINS');
    expect(getAllowedOrigins()).toEqual([]);
  });

  it('the authentication limit default is stricter than the general one', () => {
    // The whole point of a separate limiter: guessing passwords must be
    // throttled far harder than ordinary API use.
    expect(DEFAULT_AUTH_RATE_LIMIT_MAX).toBeLessThan(DEFAULT_RATE_LIMIT_MAX);
  });
});

describe('assertSecurityConfig', () => {
  it('passes with a valid configuration', () => {
    process.env.RATE_LIMIT_MAX = '100';
    process.env.JSON_BODY_LIMIT = '16kb';
    process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(() => assertSecurityConfig()).not.toThrow();
  });

  it('passes when nothing is configured, using defaults', () => {
    clear(...MANAGED_KEYS);
    expect(() => assertSecurityConfig()).not.toThrow();
  });

  it.each([
    ['RATE_LIMIT_MAX', 'not-a-number'],
    ['RATE_LIMIT_WINDOW_MS', '-5'],
    ['AUTH_RATE_LIMIT_MAX', '0'],
    ['AUTH_RATE_LIMIT_WINDOW_MS', '1.5'],
    ['JSON_BODY_LIMIT', '16gb'],
  ])('throws when %s is %j, so a broken deployment cannot start', (key, value) => {
    process.env[key] = value;
    expect(() => assertSecurityConfig()).toThrow(new RegExp(key));
  });

  it('a misconfigured limiter fails loudly rather than silently disabling protection', () => {
    process.env.RATE_LIMIT_MAX = 'unlimited';
    // The failure mode that matters: NOT "rate limiting quietly switched off".
    expect(() => assertSecurityConfig()).toThrow();
  });
});

describe('JWT secret policy constant', () => {
  it('requires a meaningful minimum length', () => {
    expect(MIN_JWT_SECRET_LENGTH).toBeGreaterThanOrEqual(32);
  });
});
