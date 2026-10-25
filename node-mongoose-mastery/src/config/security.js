// Phase 6. Every security-relevant setting is parsed and validated here, in
// one place, before the app serves a single request.
//
// The guiding rule: a misconfigured security control must fail loudly at
// startup, never silently degrade into "no protection". A typo in
// RATE_LIMIT_MAX should stop the server, not quietly disable rate limiting
// and leave everyone believing it is switched on.

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// 15 minutes. Long enough that a burst of legitimate page-loads never trips
// it, short enough that a blocked abuser is not locked out for an hour.
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Generous for a single interactive user, restrictive for a scraper.
const DEFAULT_RATE_LIMIT_MAX = 300;

// Authentication is deliberately far stricter: a human logs in once or twice,
// a credential-stuffing script tries thousands of passwords.
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

// A Task has a 100-character title and a 1000-character description, so a
// legitimate request is well under 2 KB. 16 KB leaves generous headroom while
// still refusing a multi-megabyte payload outright.
const DEFAULT_JSON_BODY_LIMIT_BYTES = 16 * 1024;

// A 32-character minimum is not a cryptographic law; it is a floor that rules
// out the secrets people actually pick under deadline pressure ("secret",
// "dev", the project name). HS256 derives a key from these bytes, so a short
// guessable secret means forgeable tokens for every user.
const MIN_JWT_SECRET_LENGTH = 32;

// Only the methods this API actually serves. Listing PUT here because "it
// might be needed later" would widen the browser-facing surface for no reason.
const ALLOWED_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

// Content-Type because every write sends JSON; Authorization because that is
// where the bearer token lives.
const ALLOWED_REQUEST_HEADERS = ['Content-Type', 'Authorization'];

const BYTE_UNITS = { b: 1, kb: 1024, mb: 1024 * 1024 };

// ---------------------------------------------------------------------------
// Parsing helpers — pure functions, independently unit-testable
// ---------------------------------------------------------------------------

function configError(message) {
  // No statusCode: a bad configuration is a server fault, and if one of these
  // ever escapes at request time it must surface as a generic 500 rather than
  // echoing configuration detail to a client.
  return new Error(message);
}

// "http://a.com, ,http://b.com" -> ['http://a.com', 'http://b.com']
// Whitespace is trimmed and empty entries dropped, so a trailing comma or a
// stray blank line in a .env file is harmless rather than producing an empty
// origin that would match nothing (or, worse, something unexpected).
function parseAllowedOrigins(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

function parsePositiveInteger(raw, name, { min = 1, max } = {}) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw configError(`${name} must be an integer ${range}`);
  }
  return parsed;
}

// Accepts "16kb", "1mb", "512b" or a plain byte count, and always returns a
// number. Converting here rather than handing a string to express.json means
// a malformed value is caught at startup instead of being silently
// reinterpreted deep inside the body parser.
function parseByteSize(raw, name) {
  if (typeof raw === 'number') return parsePositiveInteger(raw, name);

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw configError(`${name} must be a size such as 16kb, 1mb or a byte count`);
  }

  const match = raw.trim().toLowerCase().match(/^(\d+)(b|kb|mb)?$/);
  if (!match) {
    throw configError(`${name} must be a size such as 16kb, 1mb or a byte count`);
  }

  const amount = Number(match[1]);
  const unit = match[2] ?? 'b';
  const bytes = amount * BYTE_UNITS[unit];

  if (!Number.isInteger(bytes) || bytes < 1) {
    throw configError(`${name} must be a positive size`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Accessors — read process.env at call time, never at import time, so tests
// and future config loaders can set values after the module graph is built.
// ---------------------------------------------------------------------------

function getAllowedOrigins() {
  return parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
}

function getRateLimitConfig() {
  return {
    windowMs:
      process.env.RATE_LIMIT_WINDOW_MS === undefined
        ? DEFAULT_RATE_LIMIT_WINDOW_MS
        : parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 'RATE_LIMIT_WINDOW_MS'),
    limit:
      process.env.RATE_LIMIT_MAX === undefined
        ? DEFAULT_RATE_LIMIT_MAX
        : parsePositiveInteger(process.env.RATE_LIMIT_MAX, 'RATE_LIMIT_MAX'),
  };
}

function getAuthRateLimitConfig() {
  return {
    windowMs:
      process.env.AUTH_RATE_LIMIT_WINDOW_MS === undefined
        ? DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS
        : parsePositiveInteger(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 'AUTH_RATE_LIMIT_WINDOW_MS'),
    limit:
      process.env.AUTH_RATE_LIMIT_MAX === undefined
        ? DEFAULT_AUTH_RATE_LIMIT_MAX
        : parsePositiveInteger(process.env.AUTH_RATE_LIMIT_MAX, 'AUTH_RATE_LIMIT_MAX'),
  };
}

function getJsonBodyLimitBytes() {
  return process.env.JSON_BODY_LIMIT === undefined
    ? DEFAULT_JSON_BODY_LIMIT_BYTES
    : parseByteSize(process.env.JSON_BODY_LIMIT, 'JSON_BODY_LIMIT');
}

// Validates everything at once. src/server.js calls this before binding a
// port, so a deployment with a broken security setting never starts.
function assertSecurityConfig() {
  getRateLimitConfig();
  getAuthRateLimitConfig();
  getJsonBodyLimitBytes();
  getAllowedOrigins();
}

export {
  parseAllowedOrigins,
  parsePositiveInteger,
  parseByteSize,
  getAllowedOrigins,
  getRateLimitConfig,
  getAuthRateLimitConfig,
  getJsonBodyLimitBytes,
  assertSecurityConfig,
  MIN_JWT_SECRET_LENGTH,
  ALLOWED_HTTP_METHODS,
  ALLOWED_REQUEST_HEADERS,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_JSON_BODY_LIMIT_BYTES,
};
