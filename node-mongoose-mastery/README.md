# node-mongoose-mastery

A small Task Management REST API built with Node.js, Express and Mongoose.

- [docs/project-overview.md](docs/project-overview.md) — one-screen reference: every file in one line, the mechanisms that matter, and the endpoint table. Start here.
- [docs/phase-01-foundations-crud.md](docs/phase-01-foundations-crud.md) — full beginner-level walkthrough of the original CRUD implementation.
- [docs/phase-02-layered-architecture.md](docs/phase-02-layered-architecture.md) — how and why the app was reorganized into a layered (route → controller → service → repository) architecture. The API's behavior is unchanged from Phase 1; only the internal file structure changed.
- [docs/phase-03-api-standards.md](docs/phase-03-api-standards.md) — validation, filtering, search, sorting, pagination and the standardized response format added on top of that architecture. No authentication, no new resources — same Task API, production-shaped.
- [docs/phase-04-automated-testing.md](docs/phase-04-automated-testing.md) — how the automated test suite is built: unit vs. integration vs. contract tests, database isolation, mocking, test design techniques, and how to read the coverage report.
- [docs/phase-05-authentication.md](docs/phase-05-authentication.md) — users, JWT authentication, password hashing with bcrypt, and the task ownership model. Why passwords are never stored, why a JWT is signed rather than encrypted, and why another user's task returns 404 rather than 403.
- [docs/phase-06-security-hardening.md](docs/phase-06-security-hardening.md) — security headers, CORS, rate limiting, body-size limits, strict input types, JWT hardening and dependency review. Includes the threat model and an explicit list of what this phase does **not** protect against.

## Architecture

```
Request
  │
  ▼
Route            (src/routes)        — defines paths, forwards to a controller
  │
  ▼
Controller       (src/controllers)   — reads req, calls a service, sends res
  │
  ▼
Service          (src/services)      — business rules / workflow decisions
  │
  ▼
Repository       (src/repositories)  — the only place that talks to Mongoose
  │
  ▼
Mongoose Model → MongoDB
```

Errors from any layer flow up to `src/middleware/error.middleware.js`, the single place that turns them into the right HTTP status code and a safe response body. See the Phase 2 doc above for the full explanation.

Phase 3 added request-body validation as its own middleware step, in front of the controller, and gave the service layer responsibility for validating/normalizing filter, search, sort and pagination query parameters before the repository builds a query — see the Phase 3 doc above.

Phase 5 added authentication in front of that. Every task route now runs `requireAuth` first, so the chain is **auth → validation → controller**, and every task query is scoped to the authenticated user — see the Phase 5 doc above.

Phase 6 wrapped the whole thing in application-level security middleware. The full chain is now **helmet → CORS → rate limit → bounded JSON parsing → auth → validation → controller** — see the Phase 6 doc above.

```
src/
├── config/db.js                          connects to MongoDB
├── config/jwt.js                         signs/verifies JWTs; pinned HS256, 32-char minimum secret
├── config/security.js                    parses and validates CORS/rate-limit/body-size settings at startup
├── models/task.model.js                  the Task schema (priority/status, and an owner)
├── models/user.model.js                  the User schema; stores passwordHash, never a password
├── repositories/task.repository.js       Mongoose task queries — all scoped by owner
├── repositories/user.repository.js       Mongoose user queries
├── services/task.service.js              business rules, query-parameter validation, calls the repository
├── services/auth.service.js              register/login/current-user; bcrypt hashing lives here
├── controllers/task.controller.js        HTTP in/out, calls the service
├── controllers/auth.controller.js        HTTP in/out for the auth endpoints
├── routes/task.routes.js                 path → auth → validation → controller wiring
├── routes/auth.routes.js                 register/login (public), me (protected)
├── middleware/auth.middleware.js         verifies the token and attaches req.user
├── middleware/cors.middleware.js         explicit CORS allow-list, no wildcard default
├── middleware/rate-limit.middleware.js   general + stricter auth limiters, 429 envelope
├── middleware/auth-validation.middleware.js   validates register/login request bodies
├── middleware/task-validation.middleware.js   validates create/update request bodies before the controller runs
├── middleware/error.middleware.js        centralized error → HTTP response mapping (400/413/500)
├── app.js                                assembles the Express app
└── server.js                             validates all security config, connects the DB, then listens
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and fill in real values:
   ```bash
   cp .env.example .env
   ```
3. Make sure MongoDB is running and `MONGODB_URI` in `.env` points to it.
4. Set a `JWT_SECRET` in `.env`. It is **required** and must be **at least 32
   characters** — the server refuses to start otherwise, and there is
   deliberately no built-in fallback value. Generate a strong random one:
   ```bash
   openssl rand -base64 48
   ```
   Treat it like a password: never commit it, and use a different value in
   each environment. Changing it immediately invalidates every issued token.
5. Review the Phase 6 security settings in `.env`. All have safe defaults, but
   `ALLOWED_ORIGINS` has no wildcard fallback — if you leave it unset, **no
   browser origin is permitted** (non-browser clients such as curl are
   unaffected). See [Security](#security) below.
6. Start the server:
   ```bash
   npm start
   ```
   or, with automatic restarts on file changes:
   ```bash
   npm run dev
   ```

## Environment variables

| Variable | Required | Purpose | Example |
|---|---|---|---|
| `PORT` | no | Port the HTTP server listens on (default `3000`) | `3000` |
| `MONGODB_URI` | yes | Connection string for MongoDB | `mongodb://localhost:27017/task-manager` |
| `JWT_SECRET` | **yes** | Signs and verifies JWTs. **Minimum 32 characters**, no fallback | output of `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | no | How long an issued token stays valid (default `1h`) | `15m`, `1h`, `7d` |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins allowed by CORS. **Unset means none allowed** | `http://localhost:5173,http://localhost:3000` |
| `RATE_LIMIT_WINDOW_MS` | no | General rate-limit window (default `900000` = 15 min) | `900000` |
| `RATE_LIMIT_MAX` | no | General requests allowed per window (default `300`) | `300` |
| `AUTH_RATE_LIMIT_WINDOW_MS` | no | Login/register window (default `900000`) | `900000` |
| `AUTH_RATE_LIMIT_MAX` | no | Login/register requests per window (default `10`) | `10` |
| `JSON_BODY_LIMIT` | no | Max JSON body size (default `16kb`) | `16kb`, `1mb`, `32768` |

Every one of these is validated at startup. An invalid value (`RATE_LIMIT_MAX=lots`,
`JSON_BODY_LIMIT=16gb`) **stops the server** rather than silently disabling the
control it configures.

## Testing

The suite uses [Vitest](https://vitest.dev), [Supertest](https://github.com/ladjs/supertest) and [mongodb-memory-server](https://github.com/typegoose/mongodb-memory-server). It never touches the `.env` file or `MONGODB_URI` above — every test connects to a temporary, isolated in-memory MongoDB instance that exists only for the duration of the test run, and no test binds a real port or requires `npm start`/`npm run dev` to be running.

```bash
# run the full suite once and exit (this is what CI should run)
npm test

# re-run automatically on file changes (interactive)
npm run test:watch

# run once and generate a coverage report
npm run test:coverage
```

The coverage report is written to `coverage/` (open `coverage/index.html` in a browser for the interactive version); it is git-ignored and regenerated on every run.

```
tests/
├── setup/
│   ├── global-setup.js      starts/stops the one shared in-memory MongoDB for the whole run
│   ├── database.js          per-file connect/clear/disconnect helpers
│   └── test-data.js         payload factories and seeded datasets
├── unit/                    no MongoDB, no Express — pure logic, repository/mocks
└── integration/             real Express app (via Supertest) + real in-memory MongoDB
```

See [docs/phase-04-automated-testing.md](docs/phase-04-automated-testing.md) for how the suite is designed and how to read its coverage report.

## Authentication

Every `/api/tasks` endpoint is protected. Requests must carry a JWT in the
`Authorization` header:

```
Authorization: Bearer <token>
```

Tasks belong to the user who created them: you only ever see, change or delete
your own. Another user's task responds `404 Not Found` — identical to an id
that never existed — so the API never confirms that someone else's record
exists. See [docs/phase-05-authentication.md](docs/phase-05-authentication.md)
for why.

### Register — `POST /api/auth/register`

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada Lovelace","email":"ada@example.com","password":"correct-horse-battery"}'
```

```json
{ "success": true, "data": { "id": "...", "name": "Ada Lovelace", "email": "ada@example.com", "createdAt": "...", "updatedAt": "..." } }
```

`201 Created`. The password is hashed with bcrypt before storage and is never
returned by any endpoint. A duplicate email responds `409 Conflict`.

| Field | Rules |
|---|---|
| `name` | required, 3-100 characters, trimmed |
| `email` | required, must look like an email, stored lowercased and trimmed, unique |
| `password` | required, 8-72 characters (bcrypt ignores input beyond 72 bytes) |

### Log in — `POST /api/auth/login`

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}'
```

```json
{ "success": true, "data": { "token": "eyJhbGciOi...", "user": { "id": "...", "name": "Ada Lovelace", "email": "ada@example.com", "createdAt": "...", "updatedAt": "..." } } }
```

`200 OK`. Tokens expire after `JWT_EXPIRES_IN` (default one hour), after which
you log in again — there are no refresh tokens. A wrong password and an unknown
email both return the same `401` with the same message, deliberately, so the
endpoint cannot be used to discover which addresses have accounts.

### Current user — `GET /api/auth/me`

```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "success": true, "data": { "id": "...", "name": "Ada Lovelace", "email": "ada@example.com", "createdAt": "...", "updatedAt": "..." } }
```

### Using the token

Capture it once, then send it with every task request:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')

curl http://localhost:3000/api/tasks -H "Authorization: Bearer $TOKEN"
```

### Authentication failures

All of these return `401` with `{ "success": false, "message": "..." }`, and
the message never says which one applied:

| Situation | Result |
|---|---|
| No `Authorization` header | `401` |
| Not a `Bearer` scheme | `401` |
| Malformed token | `401` |
| Signature doesn't match `JWT_SECRET` | `401` |
| Expired token | `401` |
| Valid token, but the account was deleted | `401` |

## Security

Phase 6 added application-level hardening. Full reasoning, threat model and
limitations: [docs/phase-06-security-hardening.md](docs/phase-06-security-hardening.md).

> **This does not make the API production-ready.** It is hardened against
> common application-level abuse. A real deployment still needs HTTPS/TLS
> termination, a firewall or WAF, secret management, monitoring and backups —
> none of which live in application code. See section 11 of the Phase 6 doc.

**Security headers** — [Helmet](https://helmetjs.github.io/) is mounted first, so
every response carries them, including errors. `X-Powered-By` is removed;
`X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, a CSP and
HSTS are set. Note that HSTS only protects users once HTTPS is actually deployed.

**CORS** — an explicit allow-list from `ALLOWED_ORIGINS`. A disallowed browser
origin simply receives no `Access-Control-Allow-Origin` header, so the browser
blocks the response; no bespoke error code is invented and the allow-list is never
disclosed. Requests with **no** `Origin` header (curl, Postman, server-to-server)
are allowed by design — CORS is a browser mechanism and is *not* authentication.
Credentials mode is off, because this API authenticates with a bearer token
rather than cookies.

**Rate limiting** — a general limiter on `/api` (default 300 per 15 min) and a
stricter one on login/register (default 10 per 15 min). Exceeding either returns
`429` with the standard error envelope and standard `RateLimit-*` headers.
Failed logins count toward the limit; successful ones do not, so a legitimate
user cannot lock themselves out. Registration counts every request, since mass
signup is itself the abuse. Counters are in-memory and therefore per-process.

**Request size** — JSON bodies are capped (default 16 KB). Oversized requests get
`413`; malformed JSON still gets `400`.

**Strict input types** — `completed` must be a real JSON boolean. `"true"`,
`"yes"`, `1`, `0`, `null`, `[]` and `{}` are rejected with `400` on both create
and update. Duplicate or object-shaped query parameters (`?page=1&page=2`,
`?search[$ne]=x`) are rejected with `400` rather than silently resolved.

**JWT hardening** — `JWT_SECRET` is required and must be at least 32 characters.
The algorithm is pinned to `HS256` on both signing and verification, so a token
cannot dictate how it is checked (`alg: none` and algorithm-confusion attacks are
refused). The `Authorization` header must be exactly `Bearer <token>`.

### Response codes

| Code | When |
|---|---|
| `400` | Validation failure, malformed JSON, ambiguous query parameter |
| `401` | Missing, malformed, expired, tampered or unknown-user token |
| `404` | Unknown route, missing resource, or a resource owned by someone else |
| `413` | Request body over the configured limit |
| `429` | Rate limit exceeded |
| `500` | Unexpected server error (generic message only) |

Every error uses the same envelope, and none of them return stack traces,
file paths, connection strings, secrets, tokens or password hashes:

```json
{ "success": false, "message": "..." }
```

## API

Base URL: `http://localhost:3000/api/tasks` — **all endpoints below require the
`Authorization: Bearer <token>` header.**

### Response format

Every response has the same envelope. A single task:

```json
{ "success": true, "data": { "_id": "...", "title": "...", "description": "", "completed": false, "priority": "medium", "status": "todo", "owner": "...", "createdAt": "...", "updatedAt": "..." } }
```

A list of tasks (also includes `pagination`):

```json
{ "success": true, "data": [ /* tasks */ ], "pagination": { "page": 1, "limit": 10, "totalCount": 23, "totalPages": 3, "hasNextPage": true, "hasPrevPage": false } }
```

Any error, from any endpoint:

```json
{ "success": false, "message": "..." }
```

### Task fields

| Field | Type | Notes |
|---|---|---|
| `title` | string | required, 3-100 characters, trimmed |
| `description` | string | optional, up to 1000 characters |
| `completed` | boolean | default `false`; kept in sync with `status` — see below |
| `priority` | string | `low` \| `medium` \| `high`, default `medium` |
| `status` | string | `todo` \| `in-progress` \| `done`, default `todo`; kept in sync with `completed` — see below |
| `owner` | ObjectId | set automatically from the authenticated user; **cannot** be supplied or changed by the client (sending it returns `400`) |

`completed` and `status` describe the same underlying fact, so the API keeps them consistent rather than letting them disagree:

- Send only `status` → `completed` is set to match it (`done` → `true`, `todo`/`in-progress` → `false`).
- Send only `completed` → `true` sets `status` to `done`; `false` resets `status` from `done` back to `todo`, but leaves an existing `in-progress` status alone.
- Send both, and they disagree (e.g. `{"status": "done", "completed": false}`) → `400`, not a silent guess.

See [docs/phase-03-api-standards.md](docs/phase-03-api-standards.md) for the full explanation.

### Create a task

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk", "description": "2% milk", "priority": "high"}'
```

A validation failure (e.g. `{"title": "ab"}`, or an unknown `priority`) returns `400` with `{"success": false, "message": "..."}` and never reaches the database.

### List tasks, with filtering, search, sorting and pagination

```bash
# everything (page 1, 10 per page, by default)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/tasks

# filter: only completed tasks
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?completed=true"

# filter: only high-priority tasks
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?priority=high"

# filter: only tasks marked done
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?status=done"

# combine filters
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?completed=false&priority=high"

# search: partial, case-insensitive match on title
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?search=node"

# sort: oldest first
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?sortBy=createdAt&order=asc"

# sort: alphabetical by title
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?sortBy=title&order=asc"

# pagination: page 2, 5 tasks per page
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?page=2&limit=5"

# all of the above combined
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/tasks?status=todo&priority=high&search=deploy&sortBy=updatedAt&order=desc&page=1&limit=20"
```

`sortBy` must be one of `createdAt`, `updatedAt`, `title`; `order` must be `asc` or `desc`; `page` must be an integer `>= 1`; `limit` must be an integer between `1` and `100`. An invalid value for any of these returns `400` rather than being ignored. See [docs/phase-03-api-standards.md](docs/phase-03-api-standards.md) for the full explanation of each.

### Get one task

```bash
curl http://localhost:3000/api/tasks/<id> -H "Authorization: Bearer $TOKEN"
```

Returns `404` if the task does not exist **or** belongs to another user — the
two cases are deliberately indistinguishable.

### Update a task

```bash
curl -X PATCH http://localhost:3000/api/tasks/<id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"completed": true, "status": "done"}'
```

Only `title`, `description`, `completed`, `priority` and `status` are accepted. Any other field in the request body (e.g. `{"role": "admin"}`, or `{"owner": "..."}`) returns `400` rather than being silently ignored.

### Delete a task

```bash
curl -X DELETE http://localhost:3000/api/tasks/<id> -H "Authorization: Bearer $TOKEN"
```

## Troubleshooting

### "Malformed JSON in request body" (400)

If a `POST`/`PATCH` request body isn't valid JSON, the API responds `400` instead of processing it:

```bash
curl -i -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{not valid json'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"success":false,"message":"Malformed JSON in request body"}
```

Fix the JSON in the request body (a trailing comma, an unquoted key, a missing brace are common causes) and resend.

### "Invalid security configuration" on startup

The server validates its security configuration before binding a port, and
refuses to start if anything is wrong. The message names the offending variable
(never its value). Common causes:

- **`JWT_SECRET` missing or under 32 characters.** There is deliberately no
  fallback — a hardcoded default would silently become production's secret and
  let anyone who read the source forge a token for any user.
  ```bash
  openssl rand -base64 48
  ```
  Add it to `.env` as `JWT_SECRET=...` and restart. Changing an existing secret
  invalidates every token already issued, so users must log in again.
- **A malformed rate-limit or body-size value**, e.g. `RATE_LIMIT_MAX=lots` or
  `JSON_BODY_LIMIT=16gb`. Failing loudly is intentional: the alternative is a
  security control that everyone believes is on while it quietly does nothing.

To check your existing secret's length without printing it:
```bash
awk -F= '/^JWT_SECRET=/{print length($2) " characters"}' .env
```

### "429 Too Many Requests"

You have exceeded a rate limit — the stricter one (default 10 per 15 minutes)
applies to login and registration. Wait for the window to pass, or raise
`RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` in `.env` for local development. Note
that failed logins count toward the limit but successful ones do not.

### "413 Request body is too large"

The JSON body exceeded `JSON_BODY_LIMIT` (default `16kb`). A valid task is well
under 2 KB, so this usually means an unintended payload. Raise the limit in
`.env` if you genuinely need larger bodies.

### A browser gets a CORS error

The calling origin is not in `ALLOWED_ORIGINS`. Add it (comma-separated, exact
scheme/host/port match — `http://localhost:5173` and `http://localhost:51730`
are different origins) and restart. If `ALLOWED_ORIGINS` is unset, no browser
origin is permitted. This affects browsers only; curl and Postman are unaffected.

### "401 Unauthorized" on a task endpoint

Every `/api/tasks` endpoint requires `Authorization: Bearer <token>`. Check, in
order: that the header is present and spelled `Bearer`; that the token came from
`POST /api/auth/login`; that it has not expired (default lifetime one hour); and
that `JWT_SECRET` has not changed since the token was issued. The response
message is intentionally generic and will not tell you which of these applied.

### "Port already in use" on startup

If `npm start`/`npm run dev` prints `Port <PORT> is already in use.` and exits, another process (often a previous, still-running copy of this same server) already holds that port. Find out what's using it — this only *inspects* the port, it doesn't stop anything:

```bash
# macOS / Linux
lsof -i :3000

# or, using the actual PORT value from your .env
lsof -i :"$PORT"
```

This prints the process (and its PID) currently bound to the port. From there you have two safe options:

- If it's an old copy of this same server you no longer need, stop *that specific process* (e.g. `kill <PID>` using the PID `lsof` printed, or `Ctrl+C` in the terminal it's running in).
- Otherwise, pick a different port for this project by changing `PORT` in your `.env` file, and restart.

Do not run a broad "kill everything on this port" or "kill all node processes" command — `lsof` above tells you exactly which process is involved so you can stop that one deliberately, instead of affecting unrelated processes that might happen to be running on your machine.
