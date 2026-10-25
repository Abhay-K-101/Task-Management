import { EMAIL_PATTERN } from '../models/user.model.js';

// Mirrors the shape of task-validation.middleware.js on purpose: same
// accumulate-then-respond structure, same 400 envelope, same field-whitelist
// idea. A reader who understood the task validators already understands
// these.
const REGISTER_ALLOWED_FIELDS = ['name', 'email', 'password'];
const LOGIN_ALLOWED_FIELDS = ['email', 'password'];

const PASSWORD_MIN_LENGTH = 8;
// bcrypt only considers the first 72 bytes of input. Rejecting longer
// passwords outright is clearer than silently ignoring the tail, which would
// mean two different passwords could log into the same account.
const PASSWORD_MAX_LENGTH = 72;

function rejectUnknownFields(body, allowedFields, res) {
  const unknownFields = Object.keys(body).filter((key) => !allowedFields.includes(key));
  if (unknownFields.length > 0) {
    res.status(400).json({
      success: false,
      message: `Unknown field(s): ${unknownFields.join(', ')}`,
    });
    return true;
  }
  return false;
}

function validateName(name, errors) {
  if (typeof name !== 'string') {
    errors.push('name is required and must be a string');
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length < 3) {
    errors.push('name must be at least 3 characters long');
  }
  if (trimmed.length > 100) {
    errors.push('name must be at most 100 characters long');
  }
}

function validateEmail(email, errors) {
  if (typeof email !== 'string') {
    errors.push('email is required and must be a string');
    return;
  }
  if (!EMAIL_PATTERN.test(email.trim())) {
    errors.push('email must be a valid email address');
  }
}

function validatePassword(password, errors) {
  if (typeof password !== 'string') {
    errors.push('password is required and must be a string');
    return;
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`password must be at least ${PASSWORD_MIN_LENGTH} characters long`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`password must be at most ${PASSWORD_MAX_LENGTH} characters long`);
  }
}

function validateRegister(req, res, next) {
  const body = req.body || {};

  // Whitelisted before anything else so a request cannot smuggle in fields
  // like `passwordHash`, `_id` or `createdAt` and have them reach the model.
  if (rejectUnknownFields(body, REGISTER_ALLOWED_FIELDS, res)) return;

  const errors = [];
  validateName(body.name, errors);
  validateEmail(body.email, errors);
  validatePassword(body.password, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

function validateLogin(req, res, next) {
  const body = req.body || {};

  if (rejectUnknownFields(body, LOGIN_ALLOWED_FIELDS, res)) return;

  const errors = [];

  // Login deliberately checks only that the fields are present strings. It
  // does NOT apply the password-length rule: telling an anonymous caller
  // "that password is too short to be valid here" leaks the password policy,
  // and an account created before a policy change must still be able to log
  // in. Whether the credentials are right is decided by bcrypt, not here.
  if (typeof body.email !== 'string' || body.email.trim() === '') {
    errors.push('email is required and must be a string');
  }
  if (typeof body.password !== 'string' || body.password === '') {
    errors.push('password is required and must be a string');
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

export {
  validateRegister,
  validateLogin,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
};
