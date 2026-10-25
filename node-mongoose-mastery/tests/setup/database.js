import mongoose from 'mongoose';
import connectDB from '../../src/config/db.js';

// Everything in this file talks to a temporary, isolated, in-process MongoDB
// instance (started once for the whole run by tests/setup/global-setup.js).
// It never reads the developer's MONGODB_URI, never touches their .env, and
// never connects to a real local or remote database. The lifecycle is
// deliberately explicit rather than automatic: each helper is called from a
// specific Vitest hook (see the integration test files), so it is always
// obvious when a file's connection opens, when data is wiped, and when it
// closes.

// Call from `beforeAll`. Opens this file's own Mongoose connection to the
// single shared in-memory MongoDB instance (its URI is handed over via
// process.env.TEST_MONGODB_URI by global-setup.js — read only inside this
// test run, never the developer's real MONGODB_URI).
export async function connectTestDatabase() {
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    throw new Error(
      'TEST_MONGODB_URI is not set — is vitest.config.js missing globalSetup: "./tests/setup/global-setup.js"?'
    );
  }
  // Uses the real production connectDB(uri) — the same function
  // src/server.js calls — rather than a re-implementation, so the
  // integration suite genuinely exercises src/config/db.js's success path
  // instead of merely imitating it.
  await connectDB(uri);
}

// Call from `beforeEach` (or `afterEach`). Deletes every document from every
// collection Mongoose currently knows about, so each test starts from a
// known-empty database regardless of what earlier tests inserted. This is
// what makes tests independent of execution order, even though the
// underlying MongoDB instance is now shared across files.
export async function clearTestDatabase() {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((collection) => collection.deleteMany({}))
  );
}

// Call from `afterAll`. Closes this file's own Mongoose connection. The
// shared in-memory MongoDB process itself is stopped once, by
// global-setup.js's teardown(), after every file has finished — not here.
export async function disconnectTestDatabase() {
  await mongoose.disconnect();
}
