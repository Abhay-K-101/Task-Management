import mongoose from 'mongoose';

// Intentionally permissive but non-trivial: it rejects the obvious garbage
// ("abc", "a@b", "no-at-sign.com") without pretending to be RFC 5322. Full
// email validity is only ever proven by sending mail to the address, which
// is Phase 6 territory (email verification) and explicitly out of scope here.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [3, 'Name must be at least 3 characters long'],
      maxlength: [100, 'Name must be at most 100 characters long'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      unique: true,
      match: [EMAIL_PATTERN, 'Email must be a valid email address'],
    },
    // The field is named passwordHash, not password, so that every read of
    // this file makes the storage contract obvious: a plaintext password is
    // never persisted, and there is no schema path that could hold one.
    //
    // `select: false` means Mongoose omits this field from query results
    // unless a caller explicitly asks for it with .select('+passwordHash').
    // That inverts the usual risk: forgetting to strip the hash is the
    // common bug, so the default is "already stripped", and the one place
    // that genuinely needs it (login) has to opt in deliberately.
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false,
    },
  },
  {
    timestamps: true,
  }
);

// A second, independent layer of the same guarantee. Even if a document is
// loaded with the hash explicitly selected, serialising it to JSON drops the
// field — so an accidental `res.json(userDoc)` anywhere in the codebase still
// cannot leak it. Belt and braces, because a password-hash leak is the kind
// of mistake you only get to make once.
userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    return ret;
  },
});

const User = mongoose.model('User', userSchema);

export default User;
export { EMAIL_PATTERN };
