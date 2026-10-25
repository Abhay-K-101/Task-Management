import mongoose from 'mongoose';
import User from '../models/user.model.js';

// Same contract as task.repository.js: this is the only file allowed to
// speak Mongoose for users. Services above it deal in plain data and never
// build queries themselves.

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

async function create(data) {
  return User.create(data);
}

// Returns the user WITHOUT the password hash (the schema's select: false
// default applies). This is what every caller except login should use.
async function findByEmail(email) {
  return User.findOne({ email });
}

// The single deliberate exception: login needs the hash to compare against.
// The explicit '+passwordHash' is the opt-in that the schema's select: false
// forces, which is exactly why it is easy to audit — grep for this string and
// you have found every place in the codebase that can see a hash.
async function findByEmailWithPasswordHash(email) {
  return User.findOne({ email }).select('+passwordHash');
}

async function findById(id) {
  return User.findById(id);
}

export default {
  isValidId,
  create,
  findByEmail,
  findByEmailWithPasswordHash,
  findById,
};
