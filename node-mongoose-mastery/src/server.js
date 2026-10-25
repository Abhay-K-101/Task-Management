import 'dotenv/config';
import app from './app.js';
import connectDB from './config/db.js';
import { assertJwtSecretConfigured } from './config/jwt.js';
import { assertSecurityConfig } from './config/security.js';

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

async function start() {
  // Fail fast, before binding a port or touching the database.
  //
  // Without a usable secret the app cannot issue or verify a single token, so
  // every authenticated request would fail at runtime. The same reasoning
  // extends to the Phase 6 settings: a malformed RATE_LIMIT_MAX or
  // JSON_BODY_LIMIT must stop the server rather than silently degrade into a
  // disabled control that everyone believes is switched on.
  //
  // These messages name the offending variable and the requirement, never the
  // configured value — printing a secret to a log is exactly how secrets end
  // up in log aggregators.
  try {
    assertJwtSecretConfigured();
    assertSecurityConfig();
  } catch (error) {
    console.error(`Invalid security configuration: ${error.message}`);
    console.error('Fix your .env file before starting the server.');
    process.exit(1);
  }

  await connectDB(MONGODB_URI);

  const httpServer = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  httpServer.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Failed to start server:', error.message);
    }
    process.exit(1);
  });
}

start();
