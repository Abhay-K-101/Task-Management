import jwt from 'jsonwebtoken';
import { MIN_JWT_SECRET_LENGTH } from './security.js';

// Phase 6: the algorithm is named explicitly on both sign and verify, and it
// is never taken from the token.
//
// A JWT carries its own `alg` header, and a naive verifier will trust it. That
// is the root of two classic attacks: `alg: none` (claim the token needs no
// signature at all) and RS256->HS256 confusion (hand a verifier expecting a
// public key an HMAC signed *with* that public key). Passing an explicit
// allow-list to jwt.verify means the token's own header cannot influence how
// it is checked.
const JWT_ALGORITHM = 'HS256';
const ALLOWED_ALGORITHMS = [JWT_ALGORITHM];

// How long a freshly issued login token stays valid. One hour is a
// deliberate middle ground for this project: long enough that a user isn't
// re-authenticating constantly while working, short enough that a token
// copied out of a log file or left in a browser's history stops being
// useful quickly. Because Phase 5 has no refresh tokens and no session
// store, this is also the *only* expiry that exists — once it lapses the
// user must log in again, which is exactly the trade-off documented in
// docs/phase-05-authentication.md section 5.
const DEFAULT_EXPIRES_IN = '1h';

// The secret is read at call time, never captured at import time. That
// matters for two reasons: importing this module can never crash a process
// just by being loaded, and a test (or a future config loader) can set the
// value after the module graph is already built. There is deliberately no
// fallback value here — a hardcoded development secret is the single most
// common way a project ends up shipping a forgeable token in production.
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    // No statusCode is attached on purpose. This is a server misconfiguration,
    // not something the caller did wrong, so it must fall through to the
    // generic 500 handler rather than echoing configuration detail to a client.
    throw new Error('JWT_SECRET is not configured');
  }
  // Phase 6: a present-but-trivial secret is barely better than none. HS256
  // derives its key from these bytes, so "dev" or "secret" means anyone can
  // forge a token for any user. The message states the requirement and the
  // length that was supplied — never the value itself.
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long (got ${secret.length})`
    );
  }
  return secret;
}

function getExpiresIn() {
  const configured = process.env.JWT_EXPIRES_IN;
  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }
  return DEFAULT_EXPIRES_IN;
}

// The payload is kept deliberately minimal: the user's id and nothing else.
// A JWT is signed, not encrypted — anyone holding the token can read its
// contents — so it must never carry a password hash, and there is no reason
// to carry anything the server can look up itself.
function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, getSecret(), {
    algorithm: JWT_ALGORITHM,
    expiresIn: getExpiresIn(),
  });
}

// Throws jsonwebtoken's own error types (JsonWebTokenError for a bad
// signature or malformed token, TokenExpiredError for a lapsed one). Callers
// are expected to distinguish those from a configuration failure — see
// src/middleware/auth.middleware.js.
function verifyToken(token) {
  return jwt.verify(token, getSecret(), { algorithms: ALLOWED_ALGORITHMS });
}

// Used by src/server.js to fail fast at boot instead of discovering the
// missing secret on the first login attempt.
function assertJwtSecretConfigured() {
  getSecret();
}

export {
  signToken,
  verifyToken,
  assertJwtSecretConfigured,
  DEFAULT_EXPIRES_IN,
  JWT_ALGORITHM,
  ALLOWED_ALGORITHMS,
};
