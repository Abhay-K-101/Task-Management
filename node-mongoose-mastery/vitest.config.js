import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/setup/global-setup.js'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each integration test file opens its own Mongoose connection to its
    // own in-memory MongoDB (see tests/setup/database.js) and drives the
    // same imported src/app.js singleton. Verified empirically: running
    // test files in parallel (Vitest's default) caused one file's
    // beforeAll/afterAll connection lifecycle to intermittently interfere
    // with another file's requests, producing spurious failures that
    // disappeared when the same file ran alone. Per the "do not run tests
    // concurrently if shared Mongoose connection state makes that unsafe"
    // rule, file parallelism is disabled here — each file's full
    // connect -> test -> disconnect lifecycle now completes before the next
    // file starts. Tests *within* a file already ran sequentially by
    // Vitest's default and still do.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.js'],
      exclude: [
        // server.js's job is to bind a real TCP port and call process.exit.
        // The integration suite is explicitly required not to bind a real
        // port or call app.listen(), so this file's own logic cannot be
        // exercised without violating that rule. Its EADDRINUSE/startup
        // behaviour was verified manually and is documented in the Phase 1
        // corrective-pass evidence (docs/phase-01-foundations-crud.md).
        'src/server.js',
      ],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
      },
    },
  },
});
