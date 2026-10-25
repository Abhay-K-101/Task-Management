import bcrypt from 'bcrypt';
import userRepository from '../repositories/user.repository.js';
import { signToken } from '../config/jwt.js';

// bcrypt's cost factor is a deliberate speed limit. Each +1 doubles the work
// needed both to log a user in and to test a guess offline, so the number is
// a trade between login latency and how expensive a stolen-database brute
// force becomes. 12 is the common current default: a few hundred
// milliseconds per hash on ordinary hardware.
const BCRYPT_COST = 12;

// A precomputed hash of a value nobody can log in with, used only to burn a
// comparable amount of CPU when the email doesn't exist (see login below).
// It is a real bcrypt hash at the same cost factor, so the dummy comparison
// takes the same order of time as a genuine one.
const DUMMY_HASH = '$2b$12$5xHAmb6eDrtsLNw3gasq5OSYK9.L6MicHtfJ/OPvLHMgIcJHrHCDK';

function conflictError(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// One message, one status, for every possible login failure. Returning
// "no such user" for an unknown email and "wrong password" for a bad one
// would turn the login endpoint into a free membership-checking oracle:
// an attacker could harvest which addresses have accounts before ever
// trying to guess a password.
function invalidCredentialsError() {
  return Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
}

// The only shape of a user that ever leaves this service. Built by naming
// each field explicitly rather than by deleting fields from the document —
// an allow-list cannot accidentally start leaking a field that someone adds
// to the schema later, whereas a deny-list ("delete ret.passwordHash") can.
function toPublicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

async function register({ name, email, password }) {
  const normalizedEmail = normalizeEmail(email);

  // Checked up front so the common case produces a clear 409 rather than a
  // raw driver error. The unique index below is still the real guarantee —
  // see the 11000 catch.
  const existing = await userRepository.findByEmail(normalizedEmail);
  if (existing) {
    throw conflictError('An account with that email already exists');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  try {
    const user = await userRepository.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash,
    });
    return toPublicUser(user);
  } catch (error) {
    // Two requests can pass the check above simultaneously and both try to
    // insert. The unique index on `email` is what actually prevents the
    // duplicate; this converts its driver-level error into the same clean
    // 409 the checked path produces.
    if (error && error.code === 11000) {
      throw conflictError('An account with that email already exists');
    }
    throw error;
  }
}

async function login({ email, password }) {
  const normalizedEmail = normalizeEmail(email);
  const user = await userRepository.findByEmailWithPasswordHash(normalizedEmail);

  if (!user) {
    // Deliberately still run a comparison. Returning immediately here would
    // make "unknown email" measurably faster than "known email, wrong
    // password", which re-creates the enumeration oracle the shared error
    // message above exists to close.
    await bcrypt.compare(String(password), DUMMY_HASH);
    throw invalidCredentialsError();
  }

  const passwordMatches = await bcrypt.compare(String(password), user.passwordHash);
  if (!passwordMatches) {
    throw invalidCredentialsError();
  }

  return {
    token: signToken(user._id),
    user: toPublicUser(user),
  };
}

// req.user is populated by auth.middleware.js from a verified token, so by
// the time this runs the identity is already established; this simply
// presents it in the same public shape as register and login.
async function getCurrentUser(userId) {
  const user = await userRepository.findById(userId);
  if (!user) {
    // The token verified, but the account behind it is gone (deleted between
    // issuing and use). Treated as an authentication failure, not a 404.
    throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  }
  return toPublicUser(user);
}

export default {
  register,
  login,
  getCurrentUser,
  toPublicUser,
  BCRYPT_COST,
};
