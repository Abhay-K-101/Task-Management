const PRIORITY_VALUES = ['low', 'medium', 'high'];
const STATUS_VALUES = ['todo', 'in-progress', 'done'];
const UPDATE_ALLOWED_FIELDS = ['title', 'description', 'completed', 'priority', 'status'];

// Phase 5. Fields a client may never set on itself, on any request.
//
// Create deliberately does NOT enforce a full field whitelist (an unrecognised
// field is still silently ignored, as it was in Phase 3 — Mongoose drops
// anything the schema does not declare). `owner`, however, IS a declared
// schema field as of Phase 5, so Mongoose would happily persist a
// client-supplied value. Rejecting it explicitly closes that gap without
// changing the established behaviour for genuinely unknown fields.
const PROTECTED_FIELDS = ['owner'];

function validateProtectedFields(body, errors) {
  const attempted = Object.keys(body).filter((key) => PROTECTED_FIELDS.includes(key));
  if (attempted.length > 0) {
    errors.push(
      `${attempted.join(', ')} cannot be set by the client; it is assigned from the authenticated user`
    );
  }
}

function validateTitle(title, errors) {
  if (typeof title !== 'string') {
    errors.push('title is required and must be a string');
    return;
  }
  const trimmed = title.trim();
  if (trimmed.length < 3) {
    errors.push('title must be at least 3 characters long');
  }
  if (trimmed.length > 100) {
    errors.push('title must be at most 100 characters long');
  }
}

function validateOptionalTitle(title, errors) {
  if (title === undefined) return;
  validateTitle(title, errors);
}

function validateDescription(description, errors) {
  if (description === undefined) return;
  if (typeof description !== 'string') {
    errors.push('description must be a string');
    return;
  }
  if (description.length > 1000) {
    errors.push('description must be at most 1000 characters long');
  }
}

function validatePriority(priority, errors) {
  if (priority === undefined) return;
  if (!PRIORITY_VALUES.includes(priority)) {
    errors.push(`priority must be one of: ${PRIORITY_VALUES.join(', ')}`);
  }
}

// Phase 6. `completed` must be a real JSON boolean — `true` or `false` — and
// nothing else.
//
// Before this existed, create did not check the field at all and relied on
// Mongoose's Boolean cast, which is far more permissive than the public
// contract should be: it happily turns "yes"/"no"/"true"/"false"/1/0 into
// booleans, and it stores an explicit `null` as null. That last case was a
// real defect rather than a cosmetic one — a task with `completed: null` and
// `status: 'todo'` violates the completed/status invariant the whole API is
// built around, because the invariant says 'todo' implies completed === false.
//
// The wider principle: a database driver's casting rules are an
// implementation detail. They must not be allowed to define what the API
// accepts, or the contract silently changes the day the driver's coercion
// table does.
function validateCompleted(completed, errors) {
  if (completed === undefined) return;
  if (typeof completed !== 'boolean') {
    errors.push('completed must be a boolean (true or false)');
  }
}

function validateStatus(status, errors) {
  if (status === undefined) return;
  if (!STATUS_VALUES.includes(status)) {
    errors.push(`status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
}

function validateCreateTask(req, res, next) {
  const body = req.body || {};
  const errors = [];

  validateProtectedFields(body, errors);
  validateTitle(body.title, errors);
  validateDescription(body.description, errors);
  validatePriority(body.priority, errors);
  validateStatus(body.status, errors);
  validateCompleted(body.completed, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

// Note: update needs no separate protected-field check. `owner` is absent
// from UPDATE_ALLOWED_FIELDS, so the existing unknown-field whitelist already
// rejects it with 400 before any of this runs.
function validateUpdateTask(req, res, next) {
  const body = req.body || {};

  const unknownFields = Object.keys(body).filter(
    (key) => !UPDATE_ALLOWED_FIELDS.includes(key)
  );
  if (unknownFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Unknown field(s): ${unknownFields.join(', ')}`,
    });
  }

  const errors = [];

  validateOptionalTitle(body.title, errors);
  validateDescription(body.description, errors);
  validatePriority(body.priority, errors);
  validateStatus(body.status, errors);
  validateCompleted(body.completed, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

export { validateCreateTask, validateUpdateTask, validateCompleted };
