import cors from 'cors';
import {
  getAllowedOrigins,
  ALLOWED_HTTP_METHODS,
  ALLOWED_REQUEST_HEADERS,
} from '../config/security.js';

// CORS is a *browser* mechanism. It tells a browser whether JavaScript running
// on origin A is permitted to read a response from origin B. It is not
// authentication, and it stops nothing outside a browser: curl, Postman,
// Supertest and any server-to-server client ignore it entirely. Authorization
// for this API is, and remains, the bearer token checked by requireAuth.

function buildCorsOptions() {
  return {
    // Called per request with the request's Origin header (undefined when
    // there isn't one).
    origin(requestOrigin, callback) {
      // No Origin header at all: curl, Postman, a mobile app, a server-to-
      // server call, or Supertest. These are allowed through deliberately.
      // Blocking them would break every non-browser client while adding no
      // security whatsoever, because anything that can omit an Origin header
      // can equally well forge one. The real gate for these callers is the
      // JWT, not CORS.
      if (!requestOrigin) {
        return callback(null, true);
      }

      // A browser origin that is on the allow-list.
      if (getAllowedOrigins().includes(requestOrigin)) {
        return callback(null, true);
      }

      // A browser origin that is NOT on the allow-list.
      //
      // `false` means: do not send an Access-Control-Allow-Origin header. The
      // browser then refuses to expose the response to the calling page. This
      // is the standard, correct CORS rejection.
      //
      // We deliberately do NOT throw an error or fabricate a 403 here. An
      // error would reach the error handler and become a 500 (a server fault
      // for what is a client-side policy decision), and a bespoke 403 would
      // let an attacker map the allow-list by comparing status codes. Omitting
      // the header leaks nothing: every disallowed origin looks identical.
      return callback(null, false);
    },
    methods: ALLOWED_HTTP_METHODS,
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    // Authentication is a bearer token in the Authorization header, not a
    // cookie. Enabling credentials would instruct browsers to send cookies
    // and HTTP-auth headers cross-origin, which this architecture neither
    // needs nor wants — and it is incompatible with a wildcard origin anyway.
    credentials: false,
    // 204 for preflight: no body is needed, and some older browsers dislike
    // a 200 with no content.
    optionsSuccessStatus: 204,
  };
}

// Built once per process. getAllowedOrigins() is still read per request inside
// the origin callback, so the allow-list stays configurable without rebuilding
// the middleware.
const corsMiddleware = cors(buildCorsOptions());

export { corsMiddleware, buildCorsOptions };
