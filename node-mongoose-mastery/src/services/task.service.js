import taskRepository from '../repositories/task.repository.js';

const PRIORITY_VALUES = ['low', 'medium', 'high'];
const STATUS_VALUES = ['todo', 'in-progress', 'done'];
const SORT_FIELDS = ['createdAt', 'updatedAt', 'title'];
const ORDER_VALUES = ['asc', 'desc'];
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function invalidIdError() {
  return Object.assign(new Error('Invalid task id'), { statusCode: 400 });
}

function notFoundError() {
  return Object.assign(new Error('Task not found'), { statusCode: 404 });
}

function badRequestError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// Every task operation is scoped to an owner. A missing ownerId is a
// programming error (a controller that forgot to pass req.user.id, or a
// route that forgot requireAuth), never something a client can cause — so
// it throws a plain Error, which the error middleware turns into a generic
// 500 rather than a message that implies the caller did something wrong.
// Failing loudly here is the point: the alternative is an unscoped query
// that quietly returns or edits another user's data.
function assertOwner(ownerId) {
  if (!ownerId) {
    throw new Error('ownerId is required for task operations');
  }
}

const COMPLETED_FOR_STATUS = {
  done: true,
  todo: false,
  'in-progress': false,
};

function statusConflictError() {
  return badRequestError(
    "completed and status contradict each other: status 'done' requires completed true, and status 'todo'/'in-progress' requires completed false"
  );
}

// Enforces the domain invariant that `status` and `completed` must always
// agree: status 'done' <-> completed true, status 'todo'/'in-progress' <->
// completed false. `currentStatus` is the task's existing status (undefined
// on create, since there is no prior document) and is only consulted when
// `completed` is supplied without `status`.
function reconcileCompletedAndStatus(data, currentStatus) {
  const hasStatus = data.status !== undefined;
  const hasCompleted = data.completed !== undefined;

  if (hasStatus && hasCompleted) {
    if (data.completed !== COMPLETED_FOR_STATUS[data.status]) {
      throw statusConflictError();
    }
    return data;
  }

  if (hasStatus && !hasCompleted) {
    return { ...data, completed: COMPLETED_FOR_STATUS[data.status] };
  }

  if (!hasStatus && hasCompleted) {
    if (data.completed === true) {
      return { ...data, status: 'done' };
    }
    // completed === false: only pull status back to 'todo' if it was 'done'.
    // An existing 'in-progress' status must not be touched, and on create
    // there is no existing status to touch at all.
    if (currentStatus === 'done') {
      return { ...data, status: 'todo' };
    }
    return data;
  }

  return data;
}

// Phase 6. Every query parameter this endpoint recognises must arrive exactly
// once, as a single scalar value.
//
// Express's query parser turns `?page=1&page=2` into the array ['1','2'] and
// `?search[$ne]=x` into the object { $ne: 'x' }. Both are ambiguous, and
// guessing at the caller's intent is the wrong instinct: silently taking the
// first value, or the last, hides a genuine client bug and makes two
// different requests behave identically for no stated reason.
//
// Rejecting is also the shape-safe answer. An object-shaped value is how a
// NoSQL injection attempt is smuggled through a query string, and while this
// codebase already defeats that by allow-listing fields and comparing values
// against fixed sets, refusing the shape outright means the defence no longer
// depends on every future filter being written carefully.
//
// Only *recognised* parameters are checked. An unrelated parameter the API
// does not use is still ignored exactly as before, so this rule tightens the
// contract without inventing new failure modes for callers who append their
// own tracking parameters.
const RECOGNISED_QUERY_PARAMS = [
  'completed',
  'status',
  'priority',
  'sortBy',
  'order',
  'page',
  'limit',
  'search',
];

function assertScalarQueryParams(query) {
  for (const name of RECOGNISED_QUERY_PARAMS) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      throw badRequestError(`${name} must be supplied at most once, as a single value`);
    }
  }
}

function parseBooleanParam(value, fieldName) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw badRequestError(`${fieldName} must be 'true' or 'false'`);
}

function parseIntegerParam(value, fieldName, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max !== undefined ? `between ${min} and ${max}` : `>= ${min}`;
    throw badRequestError(`${fieldName} must be an integer ${range}`);
  }
  return parsed;
}

function buildFilter(query) {
  const filter = {};

  if (query.completed !== undefined) {
    filter.completed = parseBooleanParam(query.completed, 'completed');
  }

  if (query.status !== undefined) {
    if (!STATUS_VALUES.includes(query.status)) {
      throw badRequestError(`status must be one of: ${STATUS_VALUES.join(', ')}`);
    }
    filter.status = query.status;
  }

  if (query.priority !== undefined) {
    if (!PRIORITY_VALUES.includes(query.priority)) {
      throw badRequestError(`priority must be one of: ${PRIORITY_VALUES.join(', ')}`);
    }
    filter.priority = query.priority;
  }

  return filter;
}

function buildSort(query) {
  const sortBy = query.sortBy !== undefined ? query.sortBy : 'createdAt';
  if (!SORT_FIELDS.includes(sortBy)) {
    throw badRequestError(`sortBy must be one of: ${SORT_FIELDS.join(', ')}`);
  }

  const order = query.order !== undefined ? query.order : 'desc';
  if (!ORDER_VALUES.includes(order)) {
    throw badRequestError(`order must be one of: ${ORDER_VALUES.join(', ')}`);
  }

  return { sortBy, order };
}

function buildPagination(query) {
  const page =
    query.page !== undefined
      ? parseIntegerParam(query.page, 'page', { min: 1 })
      : DEFAULT_PAGE;

  const limit =
    query.limit !== undefined
      ? parseIntegerParam(query.limit, 'limit', { min: 1, max: MAX_LIMIT })
      : DEFAULT_LIMIT;

  return { page, limit };
}

function buildSearch(query) {
  if (typeof query.search === 'string' && query.search.trim() !== '') {
    return query.search.trim();
  }
  return undefined;
}

async function createTask(data, ownerId) {
  assertOwner(ownerId);
  const resolvedData = reconcileCompletedAndStatus(data, undefined);
  // `owner` is written last, so even if a client-supplied owner somehow got
  // past the validation middleware it is overwritten by the authenticated
  // user's id here. The client cannot choose who a task belongs to.
  return taskRepository.create({ ...resolvedData, owner: ownerId });
}

async function listTasks(query = {}, ownerId) {
  assertOwner(ownerId);
  // Shape first, then values. Rejecting an ambiguous parameter before parsing
  // it means nothing downstream ever has to wonder whether it holds a string
  // or an array.
  assertScalarQueryParams(query);
  const filter = buildFilter(query);
  const { sortBy, order } = buildSort(query);
  const { page, limit } = buildPagination(query);
  const search = buildSearch(query);

  const { tasks, totalCount } = await taskRepository.findAll({
    ownerId,
    filter,
    search,
    sortBy,
    order,
    page,
    limit,
  });

  const totalPages = Math.max(Math.ceil(totalCount / limit), 1);

  return {
    tasks,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
}

// Note on the 404s below: the repository only ever returns a task that
// belongs to `ownerId`, so "someone else's task" and "no such task" arrive
// here as the identical null. That is intentional — answering 403 for a task
// that exists but isn't yours would confirm its existence to a stranger, so
// both cases become the same 404.
async function getTaskById(id, ownerId) {
  assertOwner(ownerId);
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const task = await taskRepository.findById(id, ownerId);
  if (!task) {
    throw notFoundError();
  }
  return task;
}

async function updateTask(id, data, ownerId) {
  assertOwner(ownerId);
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const existing = await taskRepository.findById(id, ownerId);
  if (!existing) {
    throw notFoundError();
  }
  const resolvedData = reconcileCompletedAndStatus(data, existing.status);
  const task = await taskRepository.updateById(id, ownerId, resolvedData);
  if (!task) {
    throw notFoundError();
  }
  return task;
}

async function deleteTask(id, ownerId) {
  assertOwner(ownerId);
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const task = await taskRepository.deleteById(id, ownerId);
  if (!task) {
    throw notFoundError();
  }
  return task;
}

export default {
  createTask,
  listTasks,
  getTaskById,
  updateTask,
  deleteTask,
};
