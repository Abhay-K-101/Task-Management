import { randomBytes } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Vitest's globalSetup: setup() runs once, in the main process, before any
// test file starts; teardown() runs once after every test file finishes.
//
// Every test file needs its own isolated MongoDB, but starting a *separate*
// real mongod child process per file (8 spawn/stop cycles) turned out to be
// unreliable on this machine — empirically, it produced intermittent,
// unrelated test timeouts (see docs/phase-04-automated-testing.md, section
// 11) that disappeared whenever a file ran alone. Starting exactly one
// in-memory MongoDB for the entire run, and letting each file open its own
// Mongoose *connection* to that same instance (data isolation still comes
// from clearTestDatabase() between tests — see tests/setup/database.js),
// removes 7 of those 8 process spawns and eliminated the flakiness in
// repeated runs.
let memoryServer;

export async function setup() {
  memoryServer = await MongoMemoryServer.create();
  // Only ever read by tests/setup/database.js, inside this same test run —
  // never the developer's MONGODB_URI, never written to disk or logged.
  process.env.TEST_MONGODB_URI = memoryServer.getUri();

  // Phase 5: the app refuses to sign or verify a token without a secret, and
  // deliberately has no fallback value. Tests therefore need one of their
  // own. It is generated fresh for each run and exists only in this process's
  // environment — it is never the developer's real JWT_SECRET, never read
  // from .env, and never written anywhere.
  //
  // Phase 6 added a minimum-length rule, so this is now generated with real
  // randomness rather than Math.random(): 48 hex characters clears the
  // 32-character floor with room to spare and keeps the suite honest about
  // the policy it is testing.
  process.env.JWT_SECRET = `test-only-${randomBytes(24).toString('hex')}`;

  // Phase 6 rate limiting. These are TEST-ONLY ceilings, set high enough that
  // the ~1,500 requests a full suite run makes can never trip the shared
  // per-IP counter and turn an unrelated assertion into a spurious 429.
  //
  // This does not weaken the production defaults, which live in
  // src/config/security.js and are unaffected. The limiter's actual
  // threshold behaviour is proven deterministically in
  // tests/integration/security.rate-limit.test.js, which builds limiters from
  // the real factories with small explicit limits instead of relying on
  // whatever the ambient configuration happens to be.
  process.env.RATE_LIMIT_WINDOW_MS = String(15 * 60 * 1000);
  process.env.RATE_LIMIT_MAX = '1000000';
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = String(15 * 60 * 1000);
  process.env.AUTH_RATE_LIMIT_MAX = '1000000';
}

export async function teardown() {
  if (memoryServer) {
    await memoryServer.stop();
  }
}
