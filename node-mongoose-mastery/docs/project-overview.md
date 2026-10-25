# Project Overview (Quick Reference)

A one-stop map of the project. For the *why* behind any of this — the reasoning, the tradeoffs, the line-by-line teaching — see the phase docs linked at the bottom. This file is the *what*, kept as scannable as a codebase this size allows.

> **Scope note.** The full source listings further down are a snapshot of the code **as it stood at the end of Phase 3**. Phase 4 added a test suite (no production code changed); Phase 5 added authentication and task ownership; Phase 6 added security middleware, strict input types and JWT hardening. Phases 5 and 6 between them changed `task.model.js`, `task.repository.js`, `task.service.js`, `task.controller.js`, `task.routes.js`, `task-validation.middleware.js`, `auth.middleware.js`, `error.middleware.js`, `jwt.js`, `app.js` and `server.js` — all differ from their snapshots here. The file table, endpoint table and "mechanisms that matter" sections below **are** current. For the current code and reasoning, read [phase-05-authentication.md](phase-05-authentication.md), [phase-06-security-hardening.md](phase-06-security-hardening.md) and the source itself.

## Request flow

```
Request
  → app.js                (helmet → CORS → rate limit → bounded JSON parsing → routes → 404 + error handlers)
  → task.routes.js         (path → auth → validation → controller)
  → auth.middleware.js     (Phase 5: verifies the JWT, sets req.user, else 401)
  → task-validation.middleware.js   (create/update only — checks shape)
  → task.controller.js     (reads req + req.user.id, calls one service fn, sends res)
  → task.service.js        (business rules, cross-field checks, query validation, owner scoping)
  → task.repository.js     (the only place Mongoose queries are built — all owner-scoped)
  → Task model → MongoDB
```

Any thrown error, from any layer, skips straight to `error.middleware.js` — never falls through to a route or the 404 handler.

## Every file, at a glance

| File | Introduced | Changed | What it does |
|---|---|---|---|
| `package.json` | Phase 1 | — | Manifest: `express`, `mongoose`, `dotenv`, dev-only `nodemon`. |
| `.env.example` | Phase 1 | — | Placeholder `PORT`/`MONGODB_URI`. |
| `.gitignore` | Phase 1 | — | Ignores `node_modules/` and `.env`. |
| `src/config/db.js` | Phase 1 | — | Opens the Mongoose connection or exits cleanly on failure. |
| `src/models/task.model.js` | Phase 1 | Phase 3 | Task schema. Phase 3 added `priority`/`status` + length limits. |
| `src/app.js` | Phase 1 | Phase 1 (corrective), Phase 2 | Assembles the Express app and its middleware pipeline. |
| `src/server.js` | Phase 1 | Phase 1 (corrective) | Connects DB, then listens; handles port-in-use cleanly. |
| `src/routes/task.routes.js` | Phase 1 | Phase 2, Phase 3 | Path → controller wiring; went from doing everything to five lines. |
| `src/controllers/task.controller.js` | Phase 2 | Phase 3 | HTTP in/out only, one service call per action. |
| `src/services/task.service.js` | Phase 2 | Phase 3, Phase 3 (audit) | All business rules: id/query validation, the `completed`/`status` invariant. |
| `src/repositories/task.repository.js` | Phase 2 | Phase 3 | The only file (besides the model) that imports Mongoose. |
| `src/middleware/error.middleware.js` | Phase 2 | Phase 3, Phase 6 | Centralized error → HTTP response mapping. Phase 6 added the 413 branch. |
| `src/middleware/task-validation.middleware.js` | Phase 3 | Phase 5 | Validates create/update request body shape before the controller runs. Phase 5 added rejection of a client-supplied `owner`. |
| `vitest.config.js` | Phase 4 | — | Test runner config: includes `tests/**`, one shared in-memory MongoDB, coverage thresholds. |
| `tests/` | Phase 4 | Phase 5 | The automated suite — `setup/` helpers, `unit/`, `integration/`. Phase 5 added auth/ownership tests and auth helpers. |
| `src/config/jwt.js` | Phase 5 | Phase 6 | Signs and verifies JWTs. Phase 6 pinned HS256 explicitly and added a 32-character minimum secret length. |
| `src/models/user.model.js` | Phase 5 | — | User schema. Stores `passwordHash` (`select: false`) and strips it in `toJSON`. |
| `src/repositories/user.repository.js` | Phase 5 | — | Mongoose user queries. The only `+passwordHash` select in the codebase lives here. |
| `src/services/auth.service.js` | Phase 5 | — | Register/login/current-user. bcrypt hashing and the public-user allow-list. |
| `src/controllers/auth.controller.js` | Phase 5 | — | HTTP in/out for the three auth endpoints. |
| `src/routes/auth.routes.js` | Phase 5 | — | `register`/`login` public; `me` behind `requireAuth`. |
| `src/middleware/auth.middleware.js` | Phase 5 | — | Verifies the Bearer token, loads the user, sets `req.user`; 401 on any failure. |
| `src/middleware/auth-validation.middleware.js` | Phase 5 | — | Validates register/login request bodies. |
| `src/config/security.js` | Phase 6 | — | Parses and validates CORS / rate-limit / body-size settings; fails the boot on a bad value. |
| `src/middleware/cors.middleware.js` | Phase 6 | — | Explicit CORS allow-list. No wildcard default; no-Origin requests allowed by policy. |
| `src/middleware/rate-limit.middleware.js` | Phase 6 | — | General `/api` limiter plus stricter login/register limiters, all returning the standard 429 envelope. |

---

## File contents and phase history

### `package.json`

**Phase 1** — created with the three runtime dependencies and the `start`/`dev` scripts. Unchanged since — no phase added a package.

```json
{
  "name": "node-mongoose-mastery",
  "version": "1.0.0",
  "description": "Phase 1: Task Management REST API built with Node.js, Express and Mongoose",
  "type": "module",
  "main": "src/server.js",
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "mongoose": "^8.5.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.4"
  }
}
```

### `.env.example`

**Phase 1** — created as the safe, placeholder counterpart to the real, git-ignored `.env`. Unchanged since.

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/task-manager
```

### `.gitignore`

**Phase 1** — created. Unchanged since.

```
node_modules/
.env
```

### `src/config/db.js`

**Phase 1** — created: one function, `connectDB(uri)`, wrapping `mongoose.connect` in try/catch. On failure it logs only `error.message` (never the URI/credentials) and calls `process.exit(1)`, so the server never starts accepting requests without a working database. Unchanged in every later phase.

```javascript
import mongoose from 'mongoose';

async function connectDB(uri) {
  try {
    await mongoose.connect(uri);
    console.log('MongoDB connected');
  } catch (error) {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

export default connectDB;
```

### `src/models/task.model.js`

**Phase 1** — created with `title` (required, trimmed), `description` (optional, default `''`), `completed` (boolean, default `false`), plus `timestamps: true`.
**Phase 3** — added `priority` (`low`/`medium`/`high`, default `medium`) and `status` (`todo`/`in-progress`/`done`, default `todo`) as `enum`-validated fields, and added `minlength`/`maxlength` to `title` and `maxlength` to `description` — the same limits the validation middleware checks, enforced a second time at the database layer.

```javascript
import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters long'],
      maxlength: [100, 'Title must be at most 100 characters long'],
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: [1000, 'Description must be at most 1000 characters long'],
    },
    completed: {
      type: Boolean,
      default: false,
    },
    priority: {
      type: String,
      enum: {
        values: ['low', 'medium', 'high'],
        message: 'Priority must be one of: low, medium, high',
      },
      default: 'medium',
    },
    status: {
      type: String,
      enum: {
        values: ['todo', 'in-progress', 'done'],
        message: 'Status must be one of: todo, in-progress, done',
      },
      default: 'todo',
    },
  },
  {
    timestamps: true,
  }
);

const Task = mongoose.model('Task', taskSchema);

export default Task;
```

### `src/app.js`

**Phase 1** — created: `express()`, `express.json()`, mount the router at `/api/tasks`, a 404 catch-all, and a single generic error handler defined inline.
**Phase 1 (corrective pass)** — added a dedicated malformed-JSON error-handling middleware, registered right after `express.json()`, checking `err.type === 'entity.parse.failed'` so bad JSON returns `400` instead of falling through to the generic `500` handler.
**Phase 2** — extracted both error handlers into `middleware/error.middleware.js` and imported them here (`notFoundHandler`, `errorHandler`), consolidating the two error-handling middlewares from the corrective pass into one — Express's error-skipping behavior means a single handler at the end still catches the malformed-JSON case correctly, since `next(err)` always jumps to the *nearest* error-handling middleware, wherever it's registered.

```javascript
import express from 'express';
import taskRoutes from './routes/task.routes.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';

const app = express();

app.use(express.json());

app.use('/api/tasks', taskRoutes);

app.use(notFoundHandler);

app.use(errorHandler);

export default app;
```

### `src/server.js`

**Phase 1** — created: `connectDB` awaited, then `app.listen(PORT, callback)`.
**Phase 1 (corrective pass)** — captured `app.listen`'s return value as `httpServer` and attached `httpServer.on('error', ...)`, so a port already in use (`EADDRINUSE`) prints one clean line and exits `1`, instead of Node's default uncaught-exception crash. Unchanged in Phase 2 and 3.

```javascript
import 'dotenv/config';
import app from './app.js';
import connectDB from './config/db.js';

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

async function start() {
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
```

### `src/routes/task.routes.js`

**Phase 1** — created with all five routes, each containing its own inline Mongoose calls, id validation, and status-code decisions — the route handlers *were* the whole application.
**Phase 2** — reduced to five lines: every route now just points at a controller function; all the logic that used to live here moved to `task.controller.js`/`task.service.js`/`task.repository.js`.
**Phase 3** — added `validateCreateTask`/`validateUpdateTask` as a second argument on the `POST`/`PATCH` routes, so a request's body shape is checked before the controller ever runs.

```javascript
import { Router } from 'express';
import taskController from '../controllers/task.controller.js';
import { validateCreateTask, validateUpdateTask } from '../middleware/task-validation.middleware.js';

const router = Router();

router.post('/', validateCreateTask, taskController.createTask);
router.get('/', taskController.listTasks);
router.get('/:id', taskController.getTask);
router.patch('/:id', validateUpdateTask, taskController.updateTask);
router.delete('/:id', taskController.deleteTask);

export default router;
```

### `src/controllers/task.controller.js`

**Phase 2** — created (didn't exist before): one function per route, each reading `req`, calling exactly one service function, and sending a plain response — no Mongoose, no business logic.
**Phase 3** — every success response was wrapped in the standardized `{ success: true, data }` (plus `pagination` for the list endpoint) envelope, matching the new API-wide response format.

```javascript
import taskService from '../services/task.service.js';

async function createTask(req, res, next) {
  try {
    const task = await taskService.createTask(req.body);
    res.status(201).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function listTasks(req, res, next) {
  try {
    const { tasks, pagination } = await taskService.listTasks(req.query);
    res.status(200).json({ success: true, data: tasks, pagination });
  } catch (error) {
    next(error);
  }
}

async function getTask(req, res, next) {
  try {
    const task = await taskService.getTaskById(req.params.id);
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function updateTask(req, res, next) {
  try {
    const task = await taskService.updateTask(req.params.id, req.body);
    res.status(200).json({ success: true, data: task });
  } catch (error) {
    next(error);
  }
}

async function deleteTask(req, res, next) {
  try {
    await taskService.deleteTask(req.params.id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
}

export default {
  createTask,
  listTasks,
  getTask,
  updateTask,
  deleteTask,
};
```

### `src/services/task.service.js`

**Phase 2** — created (didn't exist before): id validation (`isValidId`) and not-found detection for `getTaskById`/`updateTask`/`deleteTask`, each throwing a plain `Error` tagged with `.statusCode` rather than a custom error class — `createTask`/`listTasks` were thin passthroughs to the repository.
**Phase 3** — `listTasks` grew `buildFilter`/`buildSort`/`buildPagination`/`buildSearch`, which validate and normalize every `GET /api/tasks` query parameter (rejecting bad values with the same tagged-`Error` pattern) before handing a clean, resolved query down to the repository, plus the pagination metadata calculation (`totalPages`/`hasNextPage`/`hasPrevPage`).
**Phase 3 (consistency audit)** — added `reconcileCompletedAndStatus`, called from both `createTask` and `updateTask`, enforcing that `completed` and `status` can never disagree (see the [Phase 3 doc](phase-03-api-standards.md#8-keeping-derived-fields-honest-the-completed--status-invariant) for the full rule). `updateTask` now fetches the existing task first — both to confirm it exists and to know its current `status`, which the derivation rule needs when only `completed` is supplied.

```javascript
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

async function createTask(data) {
  const resolvedData = reconcileCompletedAndStatus(data, undefined);
  return taskRepository.create(resolvedData);
}

async function listTasks(query = {}) {
  const filter = buildFilter(query);
  const { sortBy, order } = buildSort(query);
  const { page, limit } = buildPagination(query);
  const search = buildSearch(query);

  const { tasks, totalCount } = await taskRepository.findAll({
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

async function getTaskById(id) {
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const task = await taskRepository.findById(id);
  if (!task) {
    throw notFoundError();
  }
  return task;
}

async function updateTask(id, data) {
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const existing = await taskRepository.findById(id);
  if (!existing) {
    throw notFoundError();
  }
  const resolvedData = reconcileCompletedAndStatus(data, existing.status);
  const task = await taskRepository.updateById(id, resolvedData);
  if (!task) {
    throw notFoundError();
  }
  return task;
}

async function deleteTask(id) {
  if (!taskRepository.isValidId(id)) {
    throw invalidIdError();
  }
  const task = await taskRepository.deleteById(id);
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
```

### `src/repositories/task.repository.js`

**Phase 2** — created (didn't exist before): `isValidId`, `create`, `findById`, `updateById`, `deleteById`, and a `findAll()` that originally took no arguments and simply returned every document.
**Phase 3** — `findAll` was rewritten to accept `{ filter, search, sortBy, order, page, limit }`: it merges `filter` with a regex-escaped, case-insensitive `search` on `title`, builds the Mongoose `sort` object, computes `skip` from `page`/`limit`, and runs the paginated `Task.find(...)` alongside a `Task.countDocuments(query)` using the *same* `query` object — which is what keeps the count always consistent with the actual filtered/searched result set.

```javascript
import mongoose from 'mongoose';
import Task from '../models/task.model.js';

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function create(data) {
  return Task.create(data);
}

async function findAll({
  filter = {},
  search,
  sortBy = 'createdAt',
  order = 'desc',
  page = 1,
  limit = 10,
} = {}) {
  const query = { ...filter };

  if (search) {
    query.title = { $regex: escapeRegExp(search), $options: 'i' };
  }

  const sort = { [sortBy]: order === 'asc' ? 1 : -1 };
  const skip = (page - 1) * limit;

  const [tasks, totalCount] = await Promise.all([
    Task.find(query).sort(sort).skip(skip).limit(limit),
    Task.countDocuments(query),
  ]);

  return { tasks, totalCount };
}

async function findById(id) {
  return Task.findById(id);
}

async function updateById(id, data) {
  return Task.findByIdAndUpdate(id, data, { new: true, runValidators: true });
}

async function deleteById(id) {
  return Task.findByIdAndDelete(id);
}

export default {
  isValidId,
  create,
  findAll,
  findById,
  updateById,
  deleteById,
};
```

### `src/middleware/error.middleware.js`

**Phase 2** — created by extracting the 404 handler and the generic error handler out of `app.js` (where they'd lived inline, plus a separate dedicated JSON-parse handler from the Phase 1 corrective pass) into this one file, consolidated into `notFoundHandler` + a single `errorHandler` that checks `err.type` (malformed JSON), then `err.name` (Mongoose validation), then `err.statusCode` (a tagged service error), falling back to a generic `500`.
**Phase 3** — every response gained `success: false` alongside `message`, matching the new API-wide envelope.

```javascript
function notFoundHandler(req, res) {
  res.status(404).json({ success: false, message: 'Route not found' });
}

function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON in request body' });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ success: false, message: err.message });
  }

  if (err.statusCode) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }

  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong' });
}

export { notFoundHandler, errorHandler };
```

### `src/middleware/task-validation.middleware.js`

**Phase 3** — created (didn't exist before Phase 3 — there was no dedicated validation layer in Phase 1 or 2). `validateCreateTask` checks `title` (string, 3–100 chars after trimming), `description` (string, ≤1000 chars), `priority`/`status` (must be a real enum value if present). `validateUpdateTask` does the same for whatever fields are present, plus rejects any request body field outside `title`/`description`/`completed`/`priority`/`status` entirely. Neither function checks `completed` against `status` for contradictions — that cross-field rule was deliberately kept out of this file and placed in `task.service.js` instead (the Phase 3 consistency audit's explicit requirement: middleware validates shape/allowed-values only, the service owns cross-field business rules).

```javascript
const PRIORITY_VALUES = ['low', 'medium', 'high'];
const STATUS_VALUES = ['todo', 'in-progress', 'done'];
const UPDATE_ALLOWED_FIELDS = ['title', 'description', 'completed', 'priority', 'status'];

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

function validateStatus(status, errors) {
  if (status === undefined) return;
  if (!STATUS_VALUES.includes(status)) {
    errors.push(`status must be one of: ${STATUS_VALUES.join(', ')}`);
  }
}

function validateCreateTask(req, res, next) {
  const body = req.body || {};
  const errors = [];

  validateTitle(body.title, errors);
  validateDescription(body.description, errors);
  validatePriority(body.priority, errors);
  validateStatus(body.status, errors);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

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

  if (body.completed !== undefined && typeof body.completed !== 'boolean') {
    errors.push('completed must be a boolean');
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join('; ') });
  }

  next();
}

export { validateCreateTask, validateUpdateTask };
```

---

## The mechanisms that matter

- **Layering (Phase 2).** Every request flows Route → Controller → Service → Repository → Model, one direction only. A repository never calls a controller; a service never touches `req`/`res`.
- **Response envelope (Phase 3).** Every success is `{success: true, data}` (plus `pagination` for lists); every error, from any layer or any cause, is `{success: false, message}`.
- **Two-layer validation (Phase 3).** The middleware checks shape/allowed-values before the controller ever runs; the Mongoose schema enforces the same rules again at the database layer — a guarantee that holds even if some future code path skips the middleware.
- **Filtering / search / sort / pagination (Phase 3).** `?completed=` / `?status=` / `?priority=` are exact-match filters; `?search=` is a case-insensitive, regex-escaped partial match on `title`; `?sortBy=` / `?order=` pick the field and direction from a fixed allow-list; `?page=` / `?limit=` are bounded integers (`page ≥ 1`, `1 ≤ limit ≤ 100`), with `totalCount`/`totalPages`/`hasNextPage`/`hasPrevPage` computed from a `countDocuments` query that always shares the same filter/search criteria as the data query.
- **The `completed`/`status` invariant (Phase 3 audit).** The two fields can never disagree — `done` ⇔ `true`, `todo`/`in-progress` ⇔ `false`. Supplying only one derives the other; supplying both with a mismatch returns `400`. Enforced in `task.service.js` only.
- **Authentication (Phase 5).** A JWT carrying only the user id, signed with a required `JWT_SECRET` that has no fallback, expiring after one hour. `requireAuth` verifies it and reloads the user on every request, so a deleted account stops working immediately.
- **Password storage (Phase 5).** bcrypt at cost 12, salted automatically. Three independent layers keep the hash out of responses: `select: false` on the schema, a `toJSON` transform, and an explicit allow-list in the service.
- **Ownership (Phase 5).** Every task has a required `owner`. The client can never set it — the validator rejects it, the service overwrites it, the repository imposes it. Every task query is scoped by owner at the query level, so another user's task and a nonexistent one both return `404`, never `403`.
- **Security middleware (Phase 6).** Helmet first (headers on every response, errors included), then an explicit CORS allow-list, then rate limiting, then bounded JSON parsing — all before authentication. `trust proxy` is deliberately left disabled, because enabling it without a proxy in front would let any client spoof its IP and bypass the limiter.
- **Strict input types (Phase 6).** `completed` must be a real JSON boolean on both create and update; Mongoose's permissive casting no longer defines the contract. Recognised query parameters must arrive exactly once as scalars, so `?page=1&page=2` and `?search[$ne]=x` are rejected with 400 rather than silently resolved.
- **Error flow.** Calling `next(error)` (an argument, not a bare `next()`) skips every remaining normal middleware, route, and the 404 handler, and jumps straight to `errorHandler`, which classifies the error and answers with the right status code — a stack trace never reaches the client.

## Endpoints at a glance

All `/api/tasks` endpoints require `Authorization: Bearer <token>` as of Phase 5.

| Method | Path | Auth | Success | Failure modes |
|---|---|---|---|---|
| POST | `/api/auth/register` | public | `201` | `400` validation, `409` duplicate email |
| POST | `/api/auth/login` | public | `200` | `400` validation, `401` bad credentials |
| GET | `/api/auth/me` | required | `200` | `401` missing/invalid/expired token |
| POST | `/api/tasks` | required | `201` | `400` validation / contradiction / `owner` supplied, `401` |
| GET | `/api/tasks` | required | `200` (+ `pagination`) | `400` invalid filter/sort/pagination value, `401` |
| GET | `/api/tasks/:id` | required | `200` | `400` invalid id, `401`, `404` not found *or not yours* |
| PATCH | `/api/tasks/:id` | required | `200` | `400` validation / unknown field / contradiction, `401`, `404` not found *or not yours* |
| DELETE | `/api/tasks/:id` | required | `204` | `400` invalid id, `401`, `404` not found *or not yours* |

Plus, everywhere: `400` malformed JSON or ambiguous query parameter, `404` unknown route, `413` oversized body, `429` rate limited, `500` generic unexpected failure.

## Where to go for more

- [docs/phase-01-foundations-crud.md](phase-01-foundations-crud.md) — beginner-level, line-by-line: every JS keyword, every Express/Mongoose concept, the original CRUD code.
- [docs/phase-02-layered-architecture.md](phase-02-layered-architecture.md) — why and how the layered architecture works (food-delivery analogy), file-by-file responsibilities.
- [docs/phase-03-api-standards.md](phase-03-api-standards.md) — validation, filtering, search, sorting, pagination, response standards, and the `completed`/`status` invariant, mentoring-style with a full request trace and a 20-question quiz.
- [docs/phase-04-automated-testing.md](phase-04-automated-testing.md) — the test suite: unit vs. integration vs. contract tests, database isolation, mocking, test-design techniques, and how to read coverage honestly.
- [docs/phase-05-authentication.md](phase-05-authentication.md) — users, bcrypt, JWTs, the auth middleware, the ownership model, common security mistakes, and a 20-question quiz.
- [docs/phase-06-security-hardening.md](phase-06-security-hardening.md) — headers, CORS, rate limiting, body limits, strict input types, JWT hardening, dependency review, a threat model, incident walkthroughs, and what the phase explicitly does *not* solve.
