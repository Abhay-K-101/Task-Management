import { verifyToken } from '../config/jwt.js';
import userRepository from '../repositories/user.repository.js';

// Every authentication failure answers with the same status and the same
// two generic messages. A caller learns "you are not authenticated" and
// nothing more — not whether the token was absent, malformed, signed with
// the wrong key, expired, or belonged to a deleted account. Detail here
// would only ever help someone probing the endpoint.
const MISSING_CREDENTIALS = 'Authentication required';
const INVALID_CREDENTIALS = 'Invalid or expired token';

// jsonwebtoken's own error names. Anything NOT in this set (a missing
// JWT_SECRET, a database outage) is a server fault, not a bad token, and
// must surface as a 500 rather than being mislabelled 401 — otherwise a
// broken deployment looks to every client like "your login is wrong".
const TOKEN_ERROR_NAMES = new Set([
  'JsonWebTokenError',
  'TokenExpiredError',
  'NotBeforeError',
]);

function unauthorized(res, message) {
  return res.status(401).json({ success: false, message });
}

// Phase 6: the header must be exactly `Bearer <token>` — one scheme, one
// token, nothing else.
//
// Splitting on whitespace (rather than slicing a fixed offset) keeps
// "Bearer   <token>" and odd casing working predictably. Requiring exactly two
// parts is what is new, and it matters because duplicate Authorization headers
// are joined by the HTTP layer into a single value: sending the header twice
// arrives as "Bearer AAA, Bearer BBB". The old code would have stitched that
// back together into one nonsense token and relied on jwt.verify to reject it.
// It did reject it — but by accident, as a malformed signature, rather than
// because the request was structurally invalid. Refusing the shape outright
// makes the rejection deliberate and keeps ambiguous credentials from ever
// reaching the verifier.
function extractBearerToken(headerValue) {
  if (typeof headerValue !== 'string') return null;

  const parts = headerValue.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  // Requiring exactly two parts already guarantees a non-empty token: the
  // value is trimmed before splitting, so a trailing-whitespace header like
  // "Bearer   " collapses to a single part and is rejected above.
  const [scheme, token] = parts;
  if (scheme.toLowerCase() !== 'bearer') return null;

  // A comma means more than one credential was supplied (the joined-duplicate
  // case above, and never a legitimate part of a JWT, which is base64url).
  if (token.includes(',')) return null;

  return token;
}

async function requireAuth(req, res, next) {
  try {
    const token = extractBearerToken(req.headers?.authorization);
    if (!token) {
      return unauthorized(res, MISSING_CREDENTIALS);
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (error) {
      if (TOKEN_ERROR_NAMES.has(error?.name)) {
        return unauthorized(res, INVALID_CREDENTIALS);
      }
      throw error;
    }

    // A token can only be produced by someone holding JWT_SECRET, so a
    // malformed `sub` should be impossible — but validating it before
    // handing it to Mongoose keeps a hypothetical bad value from becoming
    // a CastError and therefore a 500.
    if (!payload?.sub || !userRepository.isValidId(payload.sub)) {
      return unauthorized(res, INVALID_CREDENTIALS);
    }

    // The token proves the id was issued by this server; it does not prove
    // the account still exists. Loading the user on every request is what
    // makes a deleted account stop working immediately, and it is what puts
    // a real, current identity on the request instead of a stale copy of
    // whatever the token happened to say when it was minted.
    const user = await userRepository.findById(payload.sub);
    if (!user) {
      return unauthorized(res, INVALID_CREDENTIALS);
    }

    // A deliberately small, plain object — not the Mongoose document. There
    // is no path from here to a password hash even by accident, and
    // downstream layers cannot mutate and save a user document by mistake.
    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
    };

    next();
  } catch (error) {
    next(error);
  }
}

export { requireAuth, MISSING_CREDENTIALS, INVALID_CREDENTIALS };
