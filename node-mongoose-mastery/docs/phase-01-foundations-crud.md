# Phase 1: Node.js, Express, Mongoose and Basic CRUD — Full Walkthrough

## How to read this document

This document assumes no prior Node.js, Express or Mongoose experience. Section 0 builds the vocabulary you need. Sections 2–7 walk through **every file in the project**, in the order Node.js actually loads them, each with the complete final source code followed by a line-by-line explanation. Section 8 traces one HTTP request through the whole system. Section 9 is a failure-scenario reference table. Section 10 records what was actually tested (not assumed) against a real MongoDB instance. Section 11 explains what was deliberately left out of Phase 1 and why. Section 12 is an alphabetical glossary you can jump to at any time.

Every code block in this document is the **exact, final content of the file on disk** — nothing is paraphrased or shortened.

> **Corrective pass (post-verification).** After the original Phase 1 implementation and documentation were written, running the code for real (section 10) surfaced two error-handling gaps that were still within Phase 1's own stated scope — not Phase 2 features: a malformed JSON request body returned `500` instead of `400`, and a `PORT` collision (`EADDRINUSE`) crashed with an uncaught exception instead of failing intentionally. Both were fixed with small, targeted changes to `src/app.js` and `src/server.js` (no new dependencies, no restructuring, no new architectural layers), re-verified, and this document was updated to match the corrected code exactly. Sections 6, 7, 9, 10 and 12 carry explicit notes marking what changed and why, so the reasoning behind the current shape of that code isn't lost.

---

## 0. Core concepts you need before touching any file

### 0.1 What Node.js actually is

A web browser runs JavaScript inside a tab, sandboxed away from your files and network. Node.js takes the same JavaScript language and the same underlying engine that powers Chrome (Google's **V8** engine) and lets it run directly on your computer, outside a browser, with access to the file system, network sockets and environment variables. When you type `node src/server.js`, you are asking the `node` executable to read that file, compile the JavaScript in it with V8, and execute it as a normal operating-system process.

Node.js adds one crucial capability on top of the JavaScript language itself: **libuv**, a C library that gives Node.js an event loop and non-blocking I/O. This is why Node.js can handle thousands of simultaneous HTTP requests or database calls using a single thread — instead of blocking that thread while waiting for a disk read or a network response, Node hands the waiting off to the operating system and keeps executing other code. When the operating system says "the data is ready," Node schedules a callback to run. This single idea — the **event loop** — explains almost everything unusual about how this project's code is written (see 0.4 and 0.9).

### 0.2 What npm and package.json are

**npm** (Node Package Manager) is both a command-line tool and a public registry of reusable JavaScript packages. Instead of writing your own HTTP server or MongoDB driver from scratch, you declare that you depend on `express` and `mongoose`, run `npm install`, and npm downloads those packages (and everything *they* depend on) into a folder called `node_modules/`.

**package.json** is the manifest that makes this possible. It is a plain JSON file, not a JavaScript file — it cannot contain comments, functions or logic, only data. `npm install` reads it, downloads whatever is listed under `dependencies` and `devDependencies`, and writes the exact resolved versions into `package-lock.json` (a second file npm generates, not written by hand) so that every machine that installs the project gets identical versions.

### 0.3 CommonJS vs ES Modules — why this project uses `import`/`export`

Node.js has historically used its own module system called **CommonJS**, where you write `const express = require('express')` and `module.exports = something`. In 2015, the JavaScript language itself standardized a different module system called **ES Modules (ESM)**, using the `import` and `export` keywords you see in every file in this project. ESM is now the language standard used in browsers, modern bundlers and modern Node.js.

Node.js supports both, but it needs to be told which one a given file uses. It decides this primarily from **`"type": "module"`** in `package.json` (see 2.1). Because that field is set, every `.js` file in this project is parsed as an ES Module, so `import`/`export` work directly with no extra build step. Without that field, Node would try to parse these same files as CommonJS and every `import` statement would throw a `SyntaxError` before the server ever started.

### 0.4 What "the event loop" means and why it matters here

JavaScript in Node.js runs on a single thread — only one line of your JavaScript executes at any instant. When code calls something that takes time (reading a file, waiting for a database reply, waiting for a network socket), Node does **not** freeze that thread waiting for the result. It hands the operation to libuv/the OS, immediately moves on to the next piece of ready-to-run code, and comes back to your waiting code later, via a callback, once the operation finishes. The **event loop** is the mechanism that keeps checking "is anything finished yet?" and runs the matching callback when the answer is yes.

Practically, this means: while one HTTP request in this API is waiting on a MongoDB query, the single Node.js thread is completely free to start handling a second, third, or hundredth incoming HTTP request. This is why a single Node.js process can serve many concurrent clients without spawning a thread per client — a very different model from many traditional server frameworks.

### 0.5 What Express is

**Express** is a minimal web framework built on top of Node's built-in `http` module. Node's raw `http` module gives you a bare `request`/`response` object pair and nothing else — no routing, no body parsing, no convenience methods. Express adds:

- **Routing**: map an HTTP method + URL pattern (e.g. `GET /api/tasks/:id`) to a specific function.
- **Middleware**: a pipeline of functions that each get a chance to inspect or modify the request/response before the final route handler runs (or to short-circuit the pipeline entirely).
- Convenience methods like `res.status(201).json(data)` instead of manually setting HTTP headers and calling `.write()`/`.end()`.

Express itself does not know anything about databases. It only knows how to receive a raw HTTP request, run it through your configured middleware/route pipeline, and send a raw HTTP response back.

### 0.6 What MongoDB is

**MongoDB** is a *document database*. Instead of rows and tables with a fixed set of columns (as in a relational/SQL database), it stores JSON-like objects called **documents** (internally, a binary format called BSON) inside **collections**. A collection named `tasks` in this project simply holds many documents that each look like `{ _id, title, description, completed, createdAt, updatedAt, __v }`. MongoDB itself does not require every document in a collection to share the same shape — enforcing a shape is optional and is exactly what Mongoose is used for here (0.7).

MongoDB runs as its own separate server process (`mongod`), completely independent of the Node.js process. This Node.js application is a *client* of that server — it opens a network connection to it (see `MONGODB_URI` in 2.2) and sends it commands over MongoDB's own binary wire protocol.

### 0.7 What Mongoose is and why we don't talk to MongoDB directly

MongoDB's official Node.js driver lets you talk to MongoDB directly, but every query returns/accepts plain, untyped JavaScript objects, and it enforces nothing about their shape. **Mongoose** is an **ODM (Object-Document Mapper)** built on top of that driver. It lets you define a **Schema** (the shape and validation rules a document must follow), turn that schema into a **Model** (a JavaScript class-like object used to query and create documents of that shape), and get back **Documents** (objects with the fields from your schema, plus extra behavior like `.save()`) instead of bare objects. Mongoose is what gives this project:

- Enforced structure (`title` must be a string, must be present).
- Automatic type coercion and default values.
- A single shared, pooled connection to MongoDB, managed for you.

### 0.8 HTTP, REST, and status codes in one page

HTTP is a request/response protocol: a client sends a **method** (verb) and a **path**, optionally a **body**, and the server sends back a **status code** and optionally a body. **REST** is a convention (not a law enforced by any tool) for mapping application actions onto HTTP methods and paths in a predictable way. This project follows that convention:

| Method | Path | Meaning | Status on success |
|---|---|---|---|
| POST | `/api/tasks` | create a new task | `201 Created` |
| GET | `/api/tasks` | list all tasks | `200 OK` |
| GET | `/api/tasks/:id` | fetch one task | `200 OK` |
| PATCH | `/api/tasks/:id` | partially update one task | `200 OK` |
| DELETE | `/api/tasks/:id` | delete one task | `204 No Content` |

Status codes are grouped by their first digit: `2xx` = success, `4xx` = the *client* made a mistake (bad input, unknown resource), `5xx` = the *server* failed for a reason the client couldn't have prevented. This project deliberately distinguishes `400` (malformed input/id), `404` (well-formed but nonexistent resource) and `500` (unexpected server-side failure) — see section 9 for exactly which code each failure produces and why.

### 0.9 Promises, async and await in one page

Because of the event loop (0.4), any operation that takes real time in Node.js — reading a file, querying MongoDB — cannot return its result immediately with a normal `return` statement; the value simply doesn't exist yet. JavaScript represents "a value that will exist later, or an error that will happen later" with a **Promise**. Older JavaScript handled promises with `.then()`/`.catch()` chains. **`async`/`await`** (used throughout this project) is syntax sugar over promises that lets asynchronous code *read* like ordinary synchronous, top-to-bottom code, while still not blocking the event loop underneath. Every Mongoose method that talks to the database (`.find()`, `.create()`, `.findById()`, …) returns a Promise, which is why every route handler in this project is declared `async` and calls those methods with `await`.

---

## 1. Project structure

```text
node-mongoose-mastery/
├── src/
│   ├── config/
│   │   └── db.js              # connects Mongoose to MongoDB
│   ├── models/
│   │   └── task.model.js      # defines the shape of a Task document
│   ├── routes/
│   │   └── task.routes.js     # the 5 CRUD HTTP endpoints
│   ├── app.js                 # builds the Express application object
│   └── server.js              # entry point: connects DB, then starts listening
├── docs/
│   └── phase-01-foundations-crud.md
├── .env.example                # placeholder environment variables (safe to commit)
├── .gitignore                  # tells Git which files/folders never to track
├── package.json                # project manifest and dependency list
└── README.md                   # setup instructions and curl examples
```

Node loads these files in this order at boot: `server.js` is executed first (it's the file passed to `node`); its `import` statements pull in `app.js` and `config/db.js`; `app.js`'s own `import` pulls in `routes/task.routes.js`; that file's `import` pulls in `models/task.model.js`. Section 8 traces this precisely.

---

## 2. Environment and configuration files

### 2.1 package.json

**Full final content:**

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

- **`"type": "module"`** — as explained in 0.3, this is what makes every `.js` file in `src/` an ES Module, enabling `import`/`export` syntax. Remove this line and every file in the project throws `SyntaxError: Cannot use import statement outside a module` the instant `node src/server.js` runs.
- **`"main": "src/server.js"`** — declares the package's entry point if this project were ever imported as a library by another package. Not used by `npm start`, which instead reads `scripts.start` below.
- **`"scripts"`** — named shell commands runnable via `npm run <name>` (`start` and `test` can drop the word `run`: `npm start`). `"start": "node src/server.js"` runs the app once. `"dev": "nodemon src/server.js"` runs it under `nodemon`, a tool that watches your files and automatically restarts the process whenever you save a change, so you don't have to stop/restart Node manually while developing.
- **`"dependencies"`** — packages required for the app to *run*: `express` (the web framework, 0.5), `mongoose` (the MongoDB ODM, 0.7), `dotenv` (loads variables from a `.env` file into `process.env`, see `server.js` in section 7). The `^` in `"^4.19.2"` is a semver range meaning "any version compatible with 4.19.2" (i.e. `>=4.19.2 <5.0.0`) — npm is allowed to install a newer patch/minor release automatically. The versions actually installed and used to verify this project were **express 4.22.2**, **mongoose 8.24.4**, **dotenv 16.6.1** (see section 10).
- **`"devDependencies"`** — packages needed only for local development, never in production (`nodemon`). `npm install` installs both groups by default; `npm install --omit=dev` (used in some deployment pipelines) skips this group.

**What happens in memory at runtime:** none — this file is only ever read by the `npm` command-line tool and by Node's module resolver (to decide CommonJS vs ESM). It is never `import`-ed or executed by the application itself.

**Alternatives considered, not chosen in Phase 1:** pinning exact versions (no `^`) for perfectly reproducible installs — rejected because `package-lock.json` already pins exact versions for every actual install, so the `^` in `package.json` only affects the range of *new* installs, and staying on the caret range keeps the project able to receive Express 4.x/Mongoose 8.x patch fixes without manual bumps. A TypeScript build step (`"type": "module"` + `tsc`) was also not chosen for Phase 1 — see section 11.

### 2.2 .env.example

**Full final content:**

```text
PORT=3000
MONGODB_URI=mongodb://localhost:27017/task-manager
```

This file exists purely as **documentation of which environment variables the app needs**, with harmless placeholder values. A developer copies it to a real `.env` file (`cp .env.example .env`) and fills in real values for their machine — a local MongoDB instance, or a hosted one like MongoDB Atlas. `.env.example` is committed to version control on purpose; the real `.env` is not (see 2.3). This is the mechanism by which the "never place a real credential in tracked files" requirement is satisfied: the *shape* of the configuration is tracked, the *values* are not.

**Failure scenario:** if a developer forgets to create `.env` at all, `process.env.MONGODB_URI` in `server.js` is `undefined`, and `mongoose.connect(undefined)` throws synchronously inside the `try` block in `db.js`, which is caught and reported as a connection failure (see section 7 and section 9) rather than crashing with a raw stack trace.

### 2.3 .gitignore

**Full final content:**

```text
node_modules/
.env
```

Git tracks every file in a project directory by default unless told otherwise. `.gitignore` lists patterns of files/folders Git should never stage or commit, even if you `git add .`.

- **`node_modules/`** — this folder is regenerated entirely from `package.json`/`package-lock.json` by `npm install`; it can contain tens of thousands of files and must never be committed. Anyone cloning the repository runs `npm install` to recreate it locally.
- **`.env`** — this is the file that holds real secrets (a real `MONGODB_URI`, potentially with a database username/password embedded in it, and a real `PORT` if it differs from the default). Ignoring it is the primary safeguard against accidentally pushing credentials to a shared repository.

**Failure scenario / what breaks if this is missing:** without the `.env` line, `git add .` would happily stage the real `.env` file the very first time it exists on disk, and the next `git commit`/`git push` would publish live database credentials into project history — including to anyone who later clones the repository, and to Git history even if the file is deleted in a later commit (removing a committed secret from history requires special rewriting steps, not just a normal delete commit).

---

## 3. src/config/db.js

### 3.1 Responsibility

This file's only job is to open the connection between this Node.js process and MongoDB, and to fail loudly-but-safely if that connection cannot be established.

### 3.2 Full final code

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

### 3.3 Every import

- `import mongoose from 'mongoose';` — pulls in the entire Mongoose library as a single object named `mongoose` (this is a **default import**, matching the package's `export default` — see 3.5). Everything this file needs — `mongoose.connect` — hangs off that one object.

### 3.4 Line-by-line

- `async function connectDB(uri) {` — declares a function named `connectDB` that takes one parameter, `uri` (the MongoDB connection string). Marking it `async` means it always returns a Promise and allows `await` to be used inside its body (see 0.9, 3.5).
- `try {` — begins a block whose errors (thrown exceptions, or here, a rejected Promise from `await`) are caught instead of crashing the process.
- `await mongoose.connect(uri);` — asks Mongoose to open a connection to the MongoDB server described by `uri`. This call returns a Promise; `await` pauses this function (without blocking the rest of the Node process, see 0.4) until that Promise either resolves (connection succeeded) or rejects (it failed).
- `console.log('MongoDB connected');` — runs only if the line above succeeded; a plain, safe status message with no data from `uri` in it.
- `} catch (error) {` — runs if `mongoose.connect` rejected (bad host, bad credentials, network unreachable, etc.). `error` is the JavaScript `Error` object describing what went wrong.
- `console.error('MongoDB connection failed:', error.message);` — logs only `error.message` (a short human-readable string like `connect ECONNREFUSED 127.0.0.1:1`), not the whole `error` object and not `uri` itself, so a username/password embedded in the connection string is never printed. This directly satisfies the "do not log secrets" requirement — verified in section 10.
- `process.exit(1);` — immediately terminates the Node.js process with exit code `1` (by convention, any non-zero exit code signals failure to whatever started the process — a shell, a process manager, a container orchestrator). This is what makes "the server starts only after a successful database connection" true: if this line runs, `server.js` never reaches `app.listen(...)` (see section 7), so the HTTP server never opens a port at all.
- `export default connectDB;` — makes this function importable from other files as `import connectDB from './config/db.js'` (used in `server.js`).

### 3.5 JavaScript keywords used here

- **`import` / `export default`** — ES Module syntax (0.3). `export default` marks *one* value per file as "the" thing this module provides; the importer can name it anything (`connectDB` here matches the original name by convention, but that's not required).
- **`async`** — marks a function as asynchronous. Two effects: (1) it may use `await` inside its body; (2) whatever it `return`s (or, if nothing, `undefined`) is automatically wrapped in a resolved Promise, and any thrown error becomes a rejected Promise, rather than a synchronous throw.
- **`await`** — usable only inside an `async` function. Suspends execution of *that function* until the Promise on its right settles (resolves or rejects), without blocking the Node.js thread from doing other work (0.4, 0.9).
- **`try` / `catch`** — standard JavaScript exception handling. Combined with `await`, `try/catch` is how this project converts a rejected Promise into ordinary, synchronous-looking error-handling code, instead of a `.catch()` chain.
- **`const`** — not used directly in this file's own top level, but note `connectDB` is declared with `function`, not assigned via `const`; either would have worked here, `function` was chosen because it is hoisted (available before its own definition line) and reads clearly as "this is a named, reusable operation."

### 3.6 Express concepts used here

None. This file has no knowledge of Express, HTTP, routes or requests at all — it is pure database plumbing, intentionally decoupled from the web layer. This separation means the database-connection logic could be reused unchanged even if the web framework were swapped out later (see section 11).

### 3.7 Mongoose concepts used here

- **`mongoose.connect(uri)`** — opens (and internally pools) a TCP connection from this Node process to the MongoDB server at `uri`. Mongoose maintains this as a single shared **connection** object (`mongoose.connection`) used by every model in the app (`task.model.js` included) — you call `connect` exactly once at boot, not once per request.
- **Connection readiness / command buffering** — by default, Mongoose *buffers* model operations (like `Task.find()`) issued before the connection finishes opening, and replays them once it's ready, rather than failing immediately. In this project that buffering is never actually relied on, because `server.js` deliberately `await`s `connectDB` to fully finish — including success or `process.exit(1)` on failure — before `app.listen` ever runs, so no HTTP request can reach a route handler while the connection is still pending.

### 3.8 What happens in memory at runtime

When `server.js` calls `connectDB(MONGODB_URI)`, Node pushes a new **stack frame** for `connectDB` onto the call stack, with its own local binding for the parameter `uri`. Calling `mongoose.connect(uri)` hands a socket-connection request off to the underlying MongoDB driver, which itself hands it to libuv/the OS; the `connectDB` stack frame is then **popped** (because of `await`) — it does not sit blocked in memory — while the async operation continues in the background. Mongoose creates and holds one long-lived **connection object** (with an internal socket pool) as part of its own module-level state, shared by the whole process for as long as it runs. When the connection attempt finishes, the event loop schedules the continuation of `connectDB` (the code after `await mongoose.connect(uri)`) to run, a fresh (conceptual) stack frame resumes exactly where it left off, and either `console.log` or the `catch` block executes.

### 3.9 Boot flow (this file has no per-request flow)

This function runs exactly **once**, at process startup, before the HTTP server exists. It never runs again for the lifetime of the process — every subsequent database operation goes through the models (`task.model.js`) reusing the one connection this function opened, not through this function again.

### 3.10 Failure scenarios

| Cause | What happens | What the operator sees |
|---|---|---|
| `MONGODB_URI` is `undefined` (missing `.env`) | `mongoose.connect(undefined)` rejects | `MongoDB connection failed: The `uri` parameter to `openUri()` must be a string, got "undefined"`, process exits with code 1 |
| MongoDB is not running / wrong host or port | connection refused | `MongoDB connection failed: connect ECONNREFUSED <host>:<port>`, process exits with code 1 — **verified**, see section 10 |
| Wrong username/password in the URI | authentication rejected by MongoDB | `MongoDB connection failed: <auth error text>`, process exits with code 1; the credentials themselves are never printed because only `error.message` is logged, never `uri` |
| Everything correct | connection succeeds | `MongoDB connected` is logged, `connectDB` returns, `server.js` proceeds to `app.listen(...)` |

In every failure case, the process **exits immediately** rather than starting an HTTP server that would accept requests it can't actually fulfill — this is what the verification checklist means by "the server starts only after a successful database connection."

### 3.11 Alternatives considered and why not chosen in Phase 1

- **Retry/backoff loop instead of `process.exit(1)`** — a production system often wants to keep retrying a flaky connection instead of dying immediately (useful behind an orchestrator that restarts crashed containers anyway). Rejected for Phase 1 to keep the failure behavior simple, immediate and easy to verify manually; automatic restart is delegated to whatever process manager runs the app (or reserved for a later phase).
- **Logging the full `error` object (including `error.stack`) instead of just `error.message`** — a stack trace is more useful for debugging, but some MongoDB driver error types can embed connection details in nested fields beyond `.message`. Logging only `.message` was chosen as the safer default given the explicit "do not log secrets" requirement; a later phase could add a dedicated, redacted debug-logging path behind an environment flag.
- **Passing connection options (connection pool size, timeouts) explicitly to `mongoose.connect`** — left at Mongoose's defaults for Phase 1 rather than tuning them, since there is no production load yet to tune against.

---

## 4. src/models/task.model.js

### 4.1 Responsibility

Defines the *shape* every Task document must have, and produces the `Task` object used everywhere else in the app to create, read, update and delete those documents.

### 4.2 Full final code

```javascript
import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    completed: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Task = mongoose.model('Task', taskSchema);

export default Task;
```

### 4.3 Every import

- `import mongoose from 'mongoose';` — needed here for two things this file uses: the `mongoose.Schema` constructor and the `mongoose.model(...)` factory function.

### 4.4 Line-by-line

- `const taskSchema = new mongoose.Schema({ ... }, { ... });` — builds a **Schema** object: a description of fields, their types, and validation/default rules, plus schema-wide options. `new` is required because `Schema` is a JavaScript **class** (technically a constructor function) — see 4.5. This call takes two arguments: the field definitions object, and a separate options object.
- `title: { type: String, required: [true, 'Title is required'], trim: true }` —
  - `type: String` — every value stored in this field must be (or be coercible to) a JavaScript string.
  - `required: [true, 'Title is required']` — this field must be present and non-empty; the array form lets you supply a **custom validation-error message** (`'Title is required'`) instead of Mongoose's generic default message. Note `title` has no `default`, which is intentional: a task without a title is meaningless, so there is no sensible default value — omitting it must be a validation error, not silently filled in.
  - `trim: true` — a **setter** Mongoose runs automatically whenever the field is assigned (including from incoming request bodies): it strips leading/trailing whitespace before the value is stored or validated. Because this setter runs *before* the `required` check, a title of `"   "` (only whitespace) is trimmed to `""` first and **does** fail the `required` check — verified in section 10.
- `description: { type: String, trim: true, default: '' }` — same string type and trimming behavior as `title`, but with `default: ''`: if a request simply omits `description`, Mongoose fills it in as an empty string rather than leaving it `undefined` or rejecting the request.
- `completed: { type: Boolean, default: false }` — a true/false field; if omitted from a request, it defaults to `false` (a freshly created task starts out not completed).
- `{ timestamps: true }` (second argument to `Schema`) — tells Mongoose to automatically add and manage two extra `Date` fields not listed above: `createdAt` (set once, at creation) and `updatedAt` (set at creation, and automatically refreshed on `.save()` **and** on the `findByIdAndUpdate`-style query used by the PATCH route — verified in section 10). Neither field is ever set by application code directly.
- `const Task = mongoose.model('Task', taskSchema);` — registers the schema under the name `'Task'` and returns a **Model**: a callable/queryable object (`Task.create`, `Task.find`, `Task.findById`, …) that is this app's entire interface to the `tasks` collection in MongoDB. Mongoose derives the actual MongoDB collection name automatically from the model name by lowercasing and pluralizing it: `'Task'` → collection `tasks`.
- `export default Task;` — the rest of the app imports this exact model object (`task.routes.js` does), never the raw MongoDB collection.

### 4.5 JavaScript keywords used here

- **`import` / `export default`** — as in 3.5.
- **`const`** — both `taskSchema` and `Task` are declared with `const` because neither binding is ever reassigned after being set; only `const` (not `let`) communicates that guarantee to a reader (and to the JS engine, which can reject accidental reassignment as a `TypeError`).
- **`new`** — required specifically for `mongoose.Schema`, because it is implemented as a JavaScript class/constructor function; calling a constructor without `new` either throws or produces a broken, un-initialized object depending on how that constructor is written. (`mongoose.model(...)`, by contrast, is a plain factory *function*, not a constructor, so it is deliberately called **without** `new`.)
- **Object literals / nested objects** — the `{ type: String, required: [...], trim: true }` syntax is plain JavaScript object notation, not special Mongoose syntax; Mongoose simply reads specific known keys (`type`, `required`, `trim`, `default`) off each field's object.
- **Arrays as values** — `[true, 'Title is required']` is an ordinary two-element JavaScript array, used here purely because Mongoose's API specifically recognizes "an array where the first element is the actual required flag and the second is a custom message" as a shorthand.

### 4.6 Express concepts used here

None — like `db.js`, this file has zero knowledge of HTTP, requests or Express. A "Task" is a plain data concept; only `task.routes.js` connects it to the web.

### 4.7 Mongoose concepts used here

- **Schema** — the structural contract described above.
- **SchemaTypes** — `String` and `Boolean` here are JavaScript's own built-in constructors, but when used as the `type` key inside a Mongoose schema field, Mongoose interprets them as its own `SchemaString`/`SchemaBoolean` types, each bringing its own set of options (`trim` only makes sense for strings, for example) and its own coercion rules (e.g. a Boolean field passed the string `"true"` from a client is coerced to the real boolean `true`).
- **Validation** — `required` is a built-in **validator**. Validators run automatically before a document is saved (`Task.create`, `.save()`) and, because the routes explicitly pass `runValidators: true`, also before `findByIdAndUpdate` applies an update (see section 5). A failed validator produces a `mongoose.Error.ValidationError`, which `task.routes.js` specifically checks for by name to turn into an HTTP `400` response (section 5).
- **Defaults** — `default: ''` / `default: false` only apply when a field is completely absent from the data being saved; they never overwrite an explicitly provided value (even `null`, which Mongoose treats as "explicitly set," is left alone — only `undefined`/absent triggers a default).
- **`mongoose.model(name, schema)`** — the factory that turns a passive Schema description into an active, queryable Model. This is also where the link to a specific MongoDB collection is established.
- **Timestamps** (`{ timestamps: true }`) — a schema-level option, not a field you define yourself; Mongoose injects `createdAt`/`updatedAt` into both the schema definition and its internal save/update hooks.

### 4.8 What happens in memory at runtime

`new mongoose.Schema(...)` builds one in-memory JavaScript object (`taskSchema`) that holds the field definitions, validators and hooks — this object is **not** a MongoDB document and is never sent to MongoDB itself; it lives purely in this Node.js process's memory as configuration. `mongoose.model('Task', taskSchema)` then builds and caches a second object, `Task`, which internally holds a reference to `taskSchema` plus the shared connection opened in `db.js`. Both `taskSchema` and `Task` are created **once**, the first time this module is `import`-ed (Node caches modules — see section 8 — so re-importing `task.model.js` from multiple files returns the same `Task` object, not a fresh one). Every actual Task **document** (e.g. the object returned by `Task.create(...)`) is a separate, short-lived JavaScript object created fresh per database operation, eligible for garbage collection once nothing (including the HTTP response cycle) still references it.

### 4.9 Request flow (N/A directly — used by every route)

This file defines no HTTP behavior itself; every route in `task.routes.js` calls a method on the `Task` object this file exports. Section 5 traces exactly how each route uses it, and section 8 traces one full example end-to-end.

### 4.10 Failure scenarios

| Cause | What happens |
|---|---|
| `Task.create({ description: 'x' })` (no `title`) | `mongoose.Error.ValidationError` thrown with message including `"Title is required"`; caught in `task.routes.js` → `400` — **verified** in section 10 |
| `Task.create({ title: '   ' })` (whitespace-only title) | `trim` runs first, value becomes `''`, `required` check fails → same `ValidationError` → `400` |
| `Task.create({ title: 'Buy milk', extra: 'ignored?' })` | Mongoose **silently drops** any field not declared in the schema (`extra` is never stored) — by default, Mongoose schemas are *not* strict about rejecting unknown fields with an error, they simply omit them |
| `findByIdAndUpdate` called with a syntactically valid but non-existent ObjectId | Query succeeds but resolves to `null` — this is **not** a Mongoose error, so `task.routes.js` must explicitly check for `null` and return `404` itself (section 5) |

### 4.11 Alternatives considered and why not chosen in Phase 1

- **`strict: 'throw'` or custom rejection of unknown fields** — Phase 1 keeps Mongoose's default lenient behavior (silently discarding unrecognized fields) rather than explicitly rejecting requests that include extra fields, to keep the API forgiving for a first implementation. A stricter contract (e.g. with a schema-validation library, see section 11) could be layered on later.
- **Storing `completed` as a string enum (`"pending" | "done"`) instead of a Boolean** — a Boolean was chosen because Phase 1's task model only needs a two-state flag; an enum would only pay off once more states are needed (e.g. `"in-progress"`), which is out of scope for Phase 1.
- **A separate `id` virtual/transform to hide MongoDB's raw `_id`/`__v` fields from API responses** — not added in Phase 1; responses currently return Mongoose's default JSON shape (`_id`, `__v` included) rather than a cleaned-up DTO, to keep the first implementation as small as possible.

---

## 5. src/routes/task.routes.js

### 5.1 Responsibility

Defines the five HTTP endpoints (POST, GET list, GET one, PATCH, DELETE) and, for each, translates an incoming HTTP request into one Mongoose call and translates the result (or error) back into an HTTP response with the correct status code.

### 5.2 Full final code

```javascript
import { Router } from 'express';
import mongoose from 'mongoose';
import Task from '../models/task.model.js';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const task = await Task.create(req.body);
    res.status(201).json(task);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const tasks = await Task.find();
    res.status(200).json(tasks);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid task id' });
    }
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.status(200).json(task);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid task id' });
    }
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.status(200).json(task);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid task id' });
    }
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
```

### 5.3 Every import

- `import { Router } from 'express';` — a **named import** (curly braces) of the `Router` function from the `express` package, distinct from the default-exported `express` function itself used in `app.js`. `Router` is a factory for building a self-contained, mountable group of routes.
- `import mongoose from 'mongoose';` — needed here specifically for `mongoose.Types.ObjectId.isValid(...)`, used to validate the `:id` route parameter *before* asking MongoDB to look it up.
- `import Task from '../models/task.model.js';` — the Task model built in section 4. The `../` means "go up one directory from `routes/` to `src/`, then into `models/`."

### 5.4 Line-by-line

- `const router = Router();` — creates a fresh, empty router object. Note this is called **without** `new` — unlike `mongoose.Schema` (4.5), Express's `Router` is designed to work as a plain factory function.
- `router.post('/', async (req, res, next) => { ... });` — registers a handler that runs for `POST` requests to this router's root path. Because this router is mounted at `/api/tasks` in `app.js`, that root path corresponds to the full path `/api/tasks` (see 5.6, section 8).
  - `req` — the **request** object: everything about the incoming HTTP request (method, URL, headers, and — because `express.json()` ran first, see section 6 — the parsed body as `req.body`).
  - `res` — the **response** object: the methods used to send data back (`res.status(...)`, `.json(...)`, `.send()`).
  - `next` — a function that, when called, either advances to the next middleware/error-handler in the pipeline (section 6), or (called with no arguments, unused directly in this file except implicitly) would move to the next route.
  - `const task = await Task.create(req.body);` — passes the entire parsed JSON body straight to Mongoose. `Task.create` builds a new document, runs schema validation/defaults/trimming, and (if valid) saves it to MongoDB — all in one call, returning the created document (with its new `_id`, `createdAt`, `updatedAt` filled in).
  - `res.status(201).json(task);` — sets the HTTP status to `201 Created` and sends the created document back as the JSON response body. `res.status(...)` returns `res` itself so `.json(...)` can be chained directly onto it.
  - `catch (error) { if (error.name === 'ValidationError') { return res.status(400).json(...); } next(error); }` — Mongoose validation failures (missing/invalid `title`) are specifically recognized by their `.name` property and turned into a `400` with the validator's message. Any *other* kind of error (e.g. MongoDB itself being unreachable mid-request) is handed to `next(error)`, which Express routes to the central error handler in `app.js` (section 6), ultimately producing a generic `500`.
- `router.get('/', async (req, res, next) => { const tasks = await Task.find(); res.status(200).json(tasks); });` — `Task.find()` with no filter argument returns **every** document in the collection, as a plain JavaScript array (empty array, not an error, if the collection has zero documents). No `try/catch` special-casing is needed here beyond the generic `catch` → `next(error)`, because there is no client-supplied input that could be invalid — this route can only fail due to an unexpected/infrastructure-level problem.
- `router.get('/:id', ...)` — `:id` is a **route parameter**: a segment of the URL path itself (not a query string, not the body) captured and made available as `req.params.id`.
  - `if (!mongoose.Types.ObjectId.isValid(req.params.id)) { return res.status(400).json(...); }` — MongoDB's primary keys (`_id`) are 24-character hexadecimal strings (technically 12-byte values) called **ObjectIds**, not arbitrary strings. If a client requests `/api/tasks/not-an-id`, asking MongoDB to look that up directly would throw a low-level driver `CastError`. This line checks the *shape* of the id **before** ever asking the database, and responds `400` immediately if it's not even a well-formed id — this is what makes "invalid MongoDB object IDs return 400, not an unhandled exception" true.
  - `const task = await Task.findById(req.params.id);` — looks up exactly one document by its `_id`. Resolves to the document if found, or to `null` if the id is well-formed but no document has it (this is a normal, non-error outcome in Mongoose/MongoDB).
  - `if (!task) { return res.status(404).json(...); }` — because "not found" is `null`, not a thrown error, the route code must explicitly check for it and choose `404` itself; nothing does this automatically.
  - `res.status(200).json(task);` — otherwise, return the found document.
- `router.patch('/:id', ...)` — same id-validation pattern as GET one, then:
  - `const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });` — finds the document by id and applies `req.body` as a **partial update** (only the fields present in the body are changed — this is what makes it PATCH semantics rather than PUT/full-replace semantics) in a single atomic database operation.
    - `new: true` — by default, Mongoose's "find and update" family of methods return the document **as it was before** the update; `new: true` asks for the **post-update** version instead, which is what the API should hand back to the caller.
    - `runValidators: true` — by default, schema validators (like `required`) only run automatically on `.save()`/`.create()`, **not** on `findByIdAndUpdate`; this option explicitly turns them on for this call too, so (for example) a PATCH that tries to set `title` to `""` is still rejected with a `400`, not silently accepted.
  - The `null`-check and `ValidationError`-check mirror the GET-one and POST handlers respectively, for the same reasons.
- `router.delete('/:id', ...)` — same id-validation pattern, then `Task.findByIdAndDelete(req.params.id)`, which finds and removes the document in one atomic operation, resolving to the deleted document or `null`.
  - `res.status(204).send();` — `204 No Content` conventionally carries **no response body** at all; `res.send()` with no argument sends an empty body (calling `.json(task)` here would be misleading, since the resource no longer exists to describe).
- `export default router;` — exports the fully configured router object as this module's single value, for `app.js` to mount.

### 5.5 JavaScript keywords used here

- **`import` (named form, `{ Router }`)** vs **`import` (default form, `Task`)** — the curly-brace form imports one specific named export among possibly several from a module; the no-braces form imports whatever that module marked as its single `export default`.
- **`const`** — `router` and every per-request `task`/`tasks` local variable are declared `const`; none are ever reassigned within their scope.
- **Arrow functions (`(req, res, next) => { ... }`)** — a compact function-expression syntax. Every route handler here is an anonymous arrow function passed directly as an argument to `router.post`/`.get`/`.patch`/`.delete`. Arrow functions do not have their own `this` binding (they inherit it from the surrounding scope) — irrelevant to correctness in this file since none of these handlers use `this`, but it's part of why arrow functions are the default choice for callbacks in modern JavaScript.
- **`async`** (on every handler) — required so `await` can be used inside each handler's body to wait on Mongoose's Promise-returning methods (0.9). If a handler were *not* declared `async`, using `await` inside it would be a `SyntaxError`.
- **`await`** — pauses each handler at the database call, resuming once MongoDB responds, without blocking Node from serving other concurrent requests in the meantime (0.4).
- **`try` / `catch`** — used in every handler to convert a rejected Promise (or synchronous throw) from Mongoose into a controlled HTTP response instead of an unhandled crash.
- **`return` (bare, inside an Express handler)** — e.g. `return res.status(400).json(...)`. The `return` here is not about the outer `async` function's own eventual resolved value (nothing reads that); it exists purely to **stop executing the rest of the handler function** immediately after sending a response — omitting it would let the same handler fall through and potentially try to send a second response, which Express would reject with an `ERR_HTTP_HEADERS_ALREADY_SENT`-style error.
- **`if` / `!` (logical NOT)** — ordinary conditionals; `!task` is `true` when `task` is `null` (or any other "falsy" value), used to detect the "not found" case; `!mongoose.Types.ObjectId.isValid(...)` inverts a boolean-returning validity check.
- **`===`** (strict equality, `error.name === 'ValidationError'`) — compares both value *and* type with no implicit coercion, the standard/safe way to compare strings in JavaScript (as opposed to `==`, which is avoided project-wide).
- **Destructuring in an import (`import { Router } from 'express'`)** — pulls one named binding out of everything the `express` package exports, without importing the rest.

### 5.6 Express concepts used here

- **Router** — a self-contained, independently-mountable collection of routes. Building routes on a `Router` instead of directly on the main `app` object (section 6) keeps route definitions modular and lets `app.js` decide *where* (`/api/tasks`) this whole group of routes lives, without this file needing to know or care.
- **Route parameters (`:id`)** — a named placeholder in the path pattern; Express captures whatever text appears in that URL segment and exposes it as `req.params.id`.
- **`req` (request object)** — in this file, specifically `req.body` (populated only because `express.json()` middleware ran earlier — section 6) and `req.params` (populated by Express's own router matching).
- **`res` (response object)** — `res.status(code)` sets the HTTP status line; `.json(value)` serializes `value` to a JSON string, sets the `Content-Type: application/json` header, and ends the response; `.send()` with no argument ends the response with an empty body.
- **`next`** — the escape hatch from a route handler to Express's error-handling machinery. Calling `next(error)` (with an argument) causes Express to skip every remaining *normal* middleware and route handler and jump straight to the nearest **error-handling middleware** (the four-argument function in `app.js`, section 6) — this is exactly how an unexpected Mongoose/MongoDB failure becomes a generic `500` instead of crashing the process.
- **HTTP method routing (`router.post` / `.get` / `.patch` / `.delete`)** — Express dispatches an incoming request to a handler only if *both* the HTTP method and the path pattern match; the same path (`'/:id'`) is reused across `GET`, `PATCH` and `DELETE` here precisely because the method distinguishes them.

### 5.7 Mongoose concepts used here

- **`Task.create(data)`** — validate + save a new document in one call; equivalent to `new Task(data).save()` but shorter.
- **`Task.find()`** — a **query** with no filter, matching every document in the collection; returns a Promise resolving to an array.
- **`Task.findById(id)`** — shorthand for `Task.findOne({ _id: id })`.
- **`Task.findByIdAndUpdate(id, update, options)`** — an atomic find-and-modify operation; the `new` and `runValidators` options control, respectively, which version of the document is returned and whether schema validation is enforced on the update (see 5.4 for both).
- **`Task.findByIdAndDelete(id)`** — an atomic find-and-remove operation, resolving to the now-deleted document (as it looked immediately before deletion) or `null`.
- **`mongoose.Types.ObjectId.isValid(value)`** — a pure, synchronous, no-database-access check of whether `value` is a syntactically valid ObjectId (24 hex characters, or a few other accepted forms) — this is what allows the code to reject malformed ids as `400` *before* ever making a network call to MongoDB.
- **`error.name === 'ValidationError'`** — every error Mongoose's built-in validators produce is an instance of `mongoose.Error.ValidationError`, whose `.name` property is always exactly the string `'ValidationError'`; checking `.name` (rather than, say, `instanceof`) is a simple, dependency-free way to distinguish "the client sent bad data" from "something else went wrong."
- **Documents as JSON** — `res.json(task)` works directly on a Mongoose document because documents implement `.toJSON()`, which Mongoose calls implicitly; this is why `_id` (an `ObjectId` object internally) serializes as a plain 24-character string in the HTTP response without any manual conversion.

### 5.8 What happens in memory at runtime

Each incoming HTTP request causes Express to create one `req` object and one `res` object, and (because these handlers are `async`) to invoke the matched handler, which returns a Promise immediately (before any database work finishes) — Express does not wait on that returned Promise itself; the handler's own internal `await` is what actually pauses progress inside the handler. While a handler's `await Task.create(req.body)` is pending, its stack frame is suspended off the main call stack, `req`/`res` remain alive in memory (referenced by that suspended frame's closure) but the Node.js thread is completely free to accept and begin processing other incoming connections. Once MongoDB's reply arrives, Node's event loop resumes exactly that suspended handler; `req`/`res` are used one final time to write the response, and then — once the response has been flushed to the socket and nothing still references them — both objects become eligible for garbage collection. `router` itself, and the `Task` model it closes over (via the top-level `import`), are created once when this module first loads and persist for the entire lifetime of the process, shared and reused by every request.

### 5.9 Request flow step-by-step (traced fully in section 8; summarized per route here)

1. Express matches the incoming method + path against this router's registered routes (only after `app.js` has already matched the `/api/tasks` prefix — section 6).
2. The matched handler runs, with `req.body`/`req.params` already populated.
3. For routes taking an `:id`, the id's *shape* is validated with zero database access.
4. Exactly one Mongoose call is awaited.
5. Success is written directly with `res.status(...).json(...)`/`.send()`.
6. Expected failures (`ValidationError`, not-found) are converted to `400`/`404` directly inside the route.
7. Unexpected failures fall through to `next(error)` and are handled centrally (section 6).

### 5.10 Failure scenarios

| Scenario | Route(s) | Result | Verified? |
|---|---|---|---|
| Missing/blank `title` | POST, PATCH | `400`, `{ message: "Task validation failed: title: Title is required" }` | Yes — section 10 |
| Malformed `:id` (e.g. `"abc"`) | GET one, PATCH, DELETE | `400`, `{ message: "Invalid task id" }` | Yes |
| Well-formed but nonexistent `:id` | GET one, PATCH, DELETE | `404`, `{ message: "Task not found" }` | Yes |
| Deleting the same id twice | DELETE | first call `204`, second call `404` | Yes |
| MongoDB becomes unreachable mid-request | any route | falls to `next(error)` → central handler → `500`, `{ message: "Something went wrong" }` | Behavior verified via the malformed-JSON case in section 6, which exercises the same central handler |
| Extremely large request body | POST, PATCH | not specially handled in Phase 1 — see `app.js` in section 6 for the actual body-size limit in effect | — |

### 5.11 Alternatives considered and why not chosen in Phase 1

- **A single generic `asyncHandler` wrapper (or the `express-async-errors` package)** to avoid repeating `try/catch` in every route — rejected for Phase 1 so that each route's error handling (in particular, the `ValidationError` → `400` special case) stays **explicit and visible** in the file a beginner is reading, rather than hidden inside a helper. Worth revisiting once the number of routes grows (section 11).
- **A request-body validation library (`express-validator`, `zod`, `joi`)** to validate `req.body` *before* it ever reaches Mongoose — not used in Phase 1 because Mongoose's own schema validation already enforces the rules this phase needs (`required`, types); a dedicated validation library becomes more valuable once rules get more complex than the schema can express (cross-field rules, custom formats) — see section 11.
- **`findOneAndUpdate` with a custom filter instead of `findByIdAndUpdate`** — `findByIdAndUpdate` was chosen because it is the more readable, purpose-built shorthand for exactly this project's need (look up by primary key); nothing in Phase 1 requires filtering by any field other than `_id`.
- **PUT (full replace) instead of/alongside PATCH** — Phase 1 exposes only PATCH (partial update) because the spec's required endpoint list only calls for PATCH; a PUT endpoint enforcing that *all* fields be supplied was left out as unnecessary duplication for this phase.
- **Soft deletes (an `isDeleted` flag) instead of `findByIdAndDelete`** — a real document removal was chosen for simplicity; soft-delete/audit-trail behavior is a reasonable future enhancement but adds query-filtering complexity (every other route would need to exclude soft-deleted documents) not justified for Phase 1.

---

## 6. src/app.js

### 6.1 Responsibility

Builds and configures the Express **application object** itself: the middleware pipeline, where the task routes are mounted, and the catch-all handlers (a malformed-JSON handler, an unknown-routes handler, and a final unexpected-error handler) that every request eventually reaches if nothing more specific handles it first.

> **Corrective-pass note.** Phase 1 verification (documented in section 10) found that a malformed JSON request body was reaching the generic error handler and returning `500` instead of `400`. That gap was found, then corrected, in this file — see the highlighted lines below and 6.6/6.10/6.11 for the full explanation of the fix. This note is kept here deliberately so the history of *why* this middleware looks the way it does isn't lost.

### 6.2 Full final code

```javascript
import express from 'express';
import taskRoutes from './routes/task.routes.js';

const app = express();

app.use(express.json());

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: 'Malformed JSON in request body' });
  }
  next(err);
});

app.use('/api/tasks', taskRoutes);

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong' });
});

export default app;
```

### 6.3 Every import

- `import express from 'express';` — the **default export** of the `express` package: a function that, when called, builds a new, empty Express application object. (Contrast with `import { Router } from 'express'` in `task.routes.js` — same package, a different named export.)
- `import taskRoutes from './routes/task.routes.js';` — the fully-built router object from section 5.

No new imports were needed for the malformed-JSON fix — it uses only the `err` object Express itself already hands to error-handling middleware, and a property (`err.type`) that Express's own bundled body-parsing code already sets. This is a deliberate design choice, not an oversight: the corrective pass was scoped to solve both gaps using only built-in Node.js and existing Express/body-parser capabilities already present in `node_modules` (see 6.6 and section 11), so no package was added to `package.json`.

### 6.4 Line-by-line

- `const app = express();` — calling the imported `express` function (no `new` — like `Router()`, this is a plain factory function) creates the **application object**: the central object representing this whole web server's configuration — its middleware pipeline, its routes, its settings. Everything below configures this one object.
- `app.use(express.json());` — registers Express's built-in JSON **body-parsing middleware** for every incoming request. `express.json()` itself is a factory call that returns a middleware *function*; `app.use(...)` is what registers it into the pipeline. Without this line, `req.body` in every route in `task.routes.js` would be `undefined`, and `Task.create(req.body)` would fail validation on every request, because none of the submitted JSON would ever be read off the incoming socket into a usable object.
- `app.use((err, req, res, next) => { if (err.type === 'entity.parse.failed') { return res.status(400).json({ message: 'Malformed JSON in request body' }); } next(err); });` — **the malformed-JSON handler, and the fix for corrective-pass gap #1.** This is a second, dedicated error-handling middleware, registered immediately after `express.json()` — the one place in the pipeline where a body-parsing failure can originate.
  - `(err, req, res, next)` — four parameters, so (exactly as in 6.5/6.6) Express treats this as an **error-handling middleware**, only ever invoked when something earlier called `next(err)` with an argument. `express.json()` is the only thing before this line, so in practice this function only ever runs in response to a body-parsing failure — or, in principle, any other error, which is exactly why the `if` check below still matters.
  - `if (err.type === 'entity.parse.failed')` — this is the load-bearing line of the whole fix. `err.type` is a property that Express's bundled JSON body-parser (a dependency called `body-parser`, vendored inside the `express` package) sets to the exact string `'entity.parse.failed'` specifically and only when `JSON.parse` fails while reading a request body — confirmed by reading `node_modules/body-parser/lib/read.js` directly (section 6.6 explains why this check, and not `instanceof SyntaxError`, is the correct one).
  - `return res.status(400).json({ message: 'Malformed JSON in request body' });` — when that specific condition is true, respond immediately with `400 Bad Request` and a short, fixed, safe message. Nothing from the request (the malformed body text, the parser's internal error message, a stack trace) is included — the message string is a hardcoded literal, not built from `err` at all, which is precisely what guarantees no parser internals or raw body ever reach the client. The `return` stops this handler here so `next(err)` below never runs for this case.
  - `next(err);` — if `err.type` is anything else (i.e. this is **not** a JSON-parsing failure), the error is forwarded, unmodified, to whatever error-handling middleware comes next in the pipeline — which is, ultimately, the generic handler at the bottom of this file. This one line is what keeps this fix narrowly scoped: it deliberately does **not** assume "any error here is a JSON problem."
- `app.use('/api/tasks', taskRoutes);` — mounts the entire `taskRoutes` router so that all of its internally-defined paths (`'/'`, `'/:id'`) are automatically prefixed with `/api/tasks`. This is the line that turns the router's `router.get('/:id', ...)` into the externally-visible `GET /api/tasks/:id`.
- `app.use((req, res) => { res.status(404).json({ message: 'Route not found' }); });` — a catch-all middleware with **no path**, registered *after* the real routes. Express middleware/routes are tried strictly **in registration order**; if a request's method+path matched nothing above this line (any path outside `/api/tasks`, or an unsupported method on a path that does exist), execution falls through to here, and this always responds `404`. This is a normal (3-argument-style, here 2-argument) middleware, not an error handler.
- `app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ message: 'Something went wrong' }); });` — the **generic error-handling middleware**, unchanged by this corrective pass. It is now the *second* error handler in the file, reached only for errors the malformed-JSON handler explicitly passed along via `next(err)` (or errors forwarded by a route via `next(error)`, section 5). `console.error(err.stack)` logs the full stack trace *to the server's own logs* (for the developer) while the client only ever receives the generic, safe message `"Something went wrong"` — the stack trace, file paths and internal error details are never sent over the network.
- `export default app;` — the fully assembled application object, consumed by `server.js` to actually start listening for connections.

### 6.5 JavaScript keywords used here

- **`import` / `export default`** — as before.
- **`const`** — `app` is declared once and never reassigned.
- **Arrow functions** — every catch-all/error handler in this file, and the middleware Express itself returns from `express.json()`, are functions; the ones written directly in this file are anonymous arrow functions passed straight to `app.use`.
- **`if` / `return` (inside the new malformed-JSON handler)** — an ordinary conditional; `return res.status(400).json(...)` both sends the response *and* immediately exits the function, exactly as in the pattern already used throughout `task.routes.js` (5.5) — this keeps `next(err)` below from ever running once a response has already been sent for this request.
- **Property access on a caught error (`err.type`)** — not a keyword, but worth calling out: `err` here is not a value this project's own code constructed: it is an object created deep inside Express's bundled body-parser, and this line reads one specific property off it. Understanding that arbitrary extra properties (`type`, `status`, `statusCode`, `body`) can be attached to a plain `Error` object — beyond the built-in `message`/`stack` — is what makes this whole check possible; JavaScript places no restriction on adding properties to an `Error` instance the same way you would to any other object.
- **Parameter count as behavior (`(req, res) => ...` vs `(err, req, res, next) => ...`)** — not a keyword, but an important, easy-to-miss piece of syntax: Express's `app.use` inspects `fn.length` (the number of declared parameters) at registration time to decide whether a function is a normal middleware or an error handler. Writing an error handler with anything other than exactly four parameters (even if the fourth, `next`, is never called) would silently make Express treat it as a normal (non-error) middleware instead, and it would never run — this is exactly as true for the new malformed-JSON handler as it was already true for the generic one.

### 6.6 Express concepts used here

- **Application object (`app`)** — the root object every other Express concept (middleware, routers, listening) attaches to.
- **Middleware pipeline / `app.use`** — the core Express mental model: an ordered list of functions, each receiving `(req, res, next)` (or `(err, req, res, next)`), each free to inspect/modify `req`/`res`, and each responsible for either calling `next()` (continue to the next function), sending a response itself (ending the pipeline), or calling `next(err)` (jump to error handling). This project's pipeline, **in order**, is now: `express.json()` → the **malformed-JSON handler** → the `/api/tasks` router → the 404 catch-all → the generic error handler.
- **`express.json()`** — a built-in middleware factory that reads the raw incoming request body, and if `Content-Type: application/json` is set, parses it as JSON and assigns the result to `req.body`. If the body is **not** valid JSON, `express.json()`'s underlying `body-parser` code itself calls `next(err)` with an error — specifically, a `SyntaxError` that has also been tagged with `err.status = 400`, `err.statusCode = 400`, `err.type = 'entity.parse.failed'`, and (importantly, and why this project's fix never reads it) `err.body` set to the raw text that failed to parse.
- **Why `express.json()` never calls the route handler when parsing fails** — calling `next(err)` **with an argument** is what tells Express "this is an error, not a normal continue." From that point, Express does not walk the pipeline in the normal, top-to-bottom way — it specifically skips every remaining *non*-error-handling middleware (that includes the entire `/api/tasks` router, and the 404 catch-all) and jumps straight to the *nearest* error-handling (four-parameter) middleware below the point of failure. That is exactly the malformed-JSON handler now sitting right after `express.json()` — so a route handler in `task.routes.js` genuinely never runs, never sees the request, and never has a chance to touch `req.body` for a request whose body wasn't valid JSON in the first place.
- **Why not every `SyntaxError` is treated as malformed JSON (the fix for corrective-pass requirement "do not classify every SyntaxError as malformed JSON")** — a `SyntaxError` can be thrown for many unrelated reasons anywhere in a Node.js program's own code (a bug in application logic, a third-party library's own internal parsing of something else entirely). If this handler checked `err instanceof SyntaxError` alone, it would incorrectly relabel *any* such unrelated failure as "malformed JSON in the request body" and return a misleading `400` to the client for what might actually be a genuine server bug deserving `500`. Checking `err.type === 'entity.parse.failed'` instead keys off a property that, in this exact dependency tree (`express`'s bundled `body-parser`, confirmed by reading its source in `node_modules`), is set **only** by the JSON body-parsing code path, for exactly this one failure mode — nothing else in this project's dependencies sets that string. This is why the malformed-JSON handler still ends with `next(err)`: any error reaching it that isn't specifically a JSON parse failure correctly falls through to the generic handler and becomes a `500`, preserving that behavior for everything else.
- **Mounting a router (`app.use('/api/tasks', taskRoutes)`)** — attaches a whole `Router` (section 5) under a path prefix; Express strips that prefix before matching against the router's own internally-registered paths.
- **Route/middleware ordering** — the malformed-JSON handler must be registered *before* the router and the 404 catch-all (a parse failure has to be caught before any route could possibly run) but *after* `express.json()` (there is nothing to catch before the parser has actually tried and failed). The two final catch-all handlers remain the *last* two registrations for the same reason as before: registering the 404 handler earlier would swallow every request, real routes included.
- **Two error-handling middlewares in one pipeline** — Express does not limit an application to a single error handler; any number may be chained, each either fully handling an error or calling `next(err)` to defer to the next one. This project now uses that directly: a narrow, specific handler for one known error shape, falling through to a broad, generic handler for everything else — a common, idiomatic Express pattern for adding one new, precise case without touching the existing catch-all's behavior.

### 6.7 Mongoose concepts used here

None directly — this file never imports `mongoose` itself; all Mongoose usage happens one layer down, inside `task.routes.js` and `task.model.js`. `app.js`'s generic error handler is what ultimately catches Mongoose/MongoDB errors that a route chose to forward via `next(error)`, without needing to know anything about Mongoose specifically; the new malformed-JSON handler is unrelated to Mongoose entirely — it only ever concerns itself with the shape of the *incoming request body*, before any route or model is ever reached.

### 6.8 What happens in memory at runtime

`express()` builds one application object, holding (internally, inside Express's own data structures) the ordered list of middleware/routers registered via `app.use`. This object is built exactly once, when `app.js` is first loaded (see section 8), and then reused — unchanged — for the entire lifetime of the process; no part of handling any individual request ever creates a new `app`. For every incoming request, Express walks this same fixed list of registered middleware in order, invoking each with a **newly created** `req`/`res` pair specific to that one request/response cycle — the middleware *functions* themselves are shared/reused across all requests (they're just JavaScript function values sitting in `app`'s internal structures), but the *data* they operate on (`req`, `res`) is fresh every time. The malformed-JSON handler adds no new long-lived state: on each parse failure, Express hands it the one `err` object created moments earlier inside `body-parser`, that object (and the raw body string held in its unused `.body` property) becomes eligible for garbage collection the instant this handler returns, having never been copied into the response or logged anywhere.

### 6.9 Request flow step-by-step

For **every** request, regardless of path:
1. Node's own HTTP server (created implicitly by `app.listen` in `server.js`) receives raw bytes off a TCP socket and parses them into an HTTP request.
2. Express wraps this into its own `req`/`res` objects and begins walking the middleware list from the top.
3. `express.json()` runs first: if there's a JSON body, it's parsed into `req.body`, and execution continues to step 4. If parsing fails, `express.json()` calls `next(err)` and execution jumps immediately to the malformed-JSON handler (step 3a) — steps 4 and 5 are skipped entirely for this request.
   - **3a.** The malformed-JSON handler checks `err.type`. If it is `'entity.parse.failed'`, it responds `400` right here and the request ends. Otherwise it calls `next(err)`, which — since nothing else registered between here and the generic handler is an error handler — jumps straight to step 6.
4. If the path starts with `/api/tasks`, control passes into the mounted router (section 5); if a route there fully handles the request (which every defined route does, on both success and its own known failure cases), the pipeline ends there and steps 5/6 never run for this request.
5. If nothing above matched at all (path outside `/api/tasks`, unsupported method), the 404 catch-all runs.
6. If any handler along the way called `next(error)` for a reason other than a JSON parse failure (a route in section 5 forwarding an unexpected Mongoose/MongoDB error, for example), the generic error-handling middleware runs, logs the error server-side, and responds `500`.

### 6.10 Failure scenarios

| Cause | Result | Verified? |
|---|---|---|
| Malformed JSON in a POST/PATCH body | `express.json()` fails to parse → `next(err)` → the malformed-JSON handler recognizes `err.type === 'entity.parse.failed'` → responds immediately, `400`, `{ "message": "Malformed JSON in request body" }` — no route handler, no 404 handler and no generic error handler ever run for this request | **Yes — corrected and re-verified; see section 10** |
| Request to a path outside `/api/tasks` (e.g. `GET /api/nonexistent`) | Falls through every route → 404 catch-all → `404`, `{ message: "Route not found" }` | Yes |
| Request body larger than Express's default body-size limit (100kb for `express.json()`) | `express.json()` rejects it with a `PayloadTooLargeError`. That error's `.type` is `'entity.too.large'`, not `'entity.parse.failed'`, so the malformed-JSON handler correctly does **not** claim it — it calls `next(err)` and the request still surfaces as `500` via the generic handler, rather than a more specific `413`. This remains an intentionally out-of-scope gap — see 6.11. | Not exercised live in section 10, but follows directly from reading the same `err.type` values in `node_modules/body-parser`, and is exactly the behavior the "do not classify every SyntaxError/every body-parser error as malformed JSON" requirement calls for |
| A route's error handler forgets to call either `res...` or `next(error)` | The request would simply **hang** — Express has no default timeout, so the client would wait indefinitely; this project's routes are written so every code path either responds or calls `next`, avoiding this |

### 6.11 Alternatives considered and why not chosen in Phase 1

- **Classifying every body-parser error type, not just `entity.parse.failed`** (e.g. also mapping `entity.too.large` → `413`, `encoding.unsupported` → `415`) — the corrective pass was deliberately scoped to the one gap actually identified by verification (malformed JSON → wrong status code); the `PayloadTooLargeError`/charset cases were not reported as failing requirements and were left returning the existing generic `500`, to keep this fix narrow rather than opening a broader "classify all possible body-parser errors" task. This is recorded here as a known, intentional remaining gap (also listed in 6.10), not something overlooked.
- **Checking `err instanceof SyntaxError && err.status === 400 && 'body' in err`** instead of `err.type === 'entity.parse.failed'` — this is a second, commonly-seen way of detecting the same body-parser failure. It was not chosen because `err.type` is the single most specific, purpose-built signal (set by body-parser precisely to identify *why* the request failed, not just *what kind of JavaScript error* was thrown) and reading it does not require reasoning about three separate conditions at once; using a plain `instanceof` check on `SyntaxError` was exactly the pattern the corrective-pass requirements warned against relying on alone.
- **Merging the malformed-JSON check into the existing generic error handler** (one handler with an `if (err.type === 'entity.parse.failed') { ... } else { ... }` branch) instead of two separate `app.use` registrations — a second, small, dedicated handler was chosen instead because it keeps the generic handler's job single-purpose ("anything reaching me is unexpected, log it, return a generic 500") and keeps the new, narrow JSON-specific logic physically next to the `express.json()` call it exists to handle, which is easier for a reader to trace top-to-bottom.
- **`cors` middleware** — not added, because Phase 1 has no browser-based frontend calling this API from a different origin yet; adding permissive CORS headers before there's a real need would be an unnecessary attack-surface increase.
- **Request logging middleware (e.g. `morgan`)** — omitted from Phase 1 to keep the middleware pipeline minimal and easy to reason about line-by-line; access logging is a reasonable addition once the API is actually deployed.
- **Helmet (security header middleware) / rate limiting** — considered "hardening" concerns explicitly out of scope for a foundations phase focused on CRUD + Mongoose fundamentals; worth adding before any real deployment.
- **Splitting `app.js` into `app.js` + a separate `routes/index.js` that aggregates multiple routers** — with only one resource (`Task`) in Phase 1, a single direct `app.use('/api/tasks', taskRoutes)` line was simpler than an extra layer of indirection that would only pay off with multiple resources.

---

## 7. src/server.js

### 7.1 Responsibility

The actual entry point of the application (the file passed to `node`). Loads environment variables, connects to the database, and — only after that succeeds — starts the HTTP server listening for real network connections, now watching explicitly for the port it asked for turning out to be unavailable.

> **Corrective-pass note.** Phase 1 verification (documented in section 10) found that if the configured `PORT` was already occupied by another process, this file had no listener for the failure, and Node's default behavior — an uncaught exception with a full stack trace dumped to the terminal — took over. That gap was found, then corrected, in this file — see the highlighted lines below and 7.6/7.10/7.11 for the full explanation of the fix.

### 7.2 Full final code

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

### 7.3 Every import

- `import 'dotenv/config';` — a **side-effect-only import**: no name is bound to anything (there's no `from ... import x`). Importing this specific path from the `dotenv` package immediately, as a side effect of being loaded, reads the `.env` file in the project root and copies every `KEY=VALUE` line it finds into `process.env`. This line must run **before** anything reads `process.env.PORT`/`process.env.MONGODB_URI` below — and it does, because ES Module imports are always fully resolved before the rest of the file's own code runs (see 7.5).
- `import app from './app.js';` — the configured Express application object from section 6.
- `import connectDB from './config/db.js';` — the connection function from section 3.

No new imports were needed for the `EADDRINUSE` fix either — `httpServer.on('error', ...)` uses only the Node.js `http.Server` object that `app.listen(...)` already returned (it was simply never captured into a variable before), and the built-in `EventEmitter` behavior every such server object already has. As with the malformed-JSON fix in `app.js`, no package was added to `package.json` for this.

### 7.4 Line-by-line

- `const PORT = process.env.PORT || 3000;` — `process` is a global object Node.js provides in every file (not something this project imports); `process.env` is a plain object holding every environment variable available to this process, as strings, including whatever `dotenv/config` just loaded from `.env`. `|| 3000` supplies a fallback: if `PORT` is unset (`undefined`, which is falsy), use `3000` instead — the project runs with a sensible default even without a `.env` file, as long as MongoDB is reachable.
- `const MONGODB_URI = process.env.MONGODB_URI;` — read once, deliberately with **no fallback** — unlike `PORT`, there is no safe default connection string to fall back to, so if this is unset it stays `undefined` and is allowed to surface as a connection failure inside `connectDB` (section 3), rather than silently pointing at a guessed database.
- `async function start() { ... }` — wraps the startup sequence in its own function so `await` can be used for `connectDB` at the top level of the file in a readable way (see 7.5 for why not top-level `await` directly).
- `await connectDB(MONGODB_URI);` — calls the function from section 3 and waits for it to fully finish. Recall from 3.4 that `connectDB` either logs success and returns normally, or logs a safe failure message and calls `process.exit(1)` — **there is no third outcome**, so the line below this one is only ever reached after a confirmed-successful connection.
- `const httpServer = app.listen(PORT, () => { console.log(...); });` — asks Express (which internally creates and starts Node's own `http.Server`) to begin accepting real TCP connections on `PORT`. **This is the first change for the `EADDRINUSE` fix**: `app.listen(...)` always returns the underlying `http.Server` object — the code previously called it and immediately discarded that return value; now it is kept in `httpServer` specifically so the next line can attach a listener to it. The second argument to `.listen` is still the same success callback Express invokes once the port is actually open and ready; logging inside that callback (rather than on the line right after `app.listen`) guarantees the log message is only printed once the server is *actually* accepting connections, not merely "requested to."
- `httpServer.on('error', (error) => { ... });` — **the second, and main, change for the `EADDRINUSE` fix.** `http.Server` objects are Node.js `EventEmitter`s (7.6 explains this concept from scratch); `.on('error', callback)` registers `callback` to run whenever the server emits an `'error'` event — which is exactly what happens if the underlying operating-system call to bind/listen on `PORT` fails, for any reason, including the port already being in use.
  - `if (error.code === 'EADDRINUSE') { console.error(\`Port ${PORT} is already in use.\`); }` — Node's networking errors carry a short, well-known `.code` string identifying *which* OS-level failure occurred; `'EADDRINUSE'` ("address in use") is the specific code for exactly this scenario (7.9 explains this term in full). When it matches, a single, concise, intentional message is printed, naming the configured port — but nothing else about the environment.
  - `else { console.error('Failed to start server:', error.message); }` — any *other* startup error (for example `'EACCES'`, attempting to bind a privileged port without permission) falls into this branch: a safe, generic message plus `error.message` (a short OS-provided description, not a stack trace and not any application secret — the same restrained style already used in `config/db.js`'s own catch block, section 3).
  - `process.exit(1);` — in **both** branches, the process terminates immediately with a non-zero exit code, exactly mirroring how `connectDB` (section 3) already reports its own startup failures. This is what turns an otherwise-uncaught, crash-with-a-stack-trace failure into the same kind of deliberate, safe, non-zero exit the rest of this project's startup path already uses for a bad database connection.
- `` console.log(`Server listening on port ${PORT}`); `` — a **template literal** (backtick string) that interpolates the `PORT` variable directly into the logged message.
- `start();` — actually invokes the function defined above; without this call, nothing in `start` would ever run, and the process would load all its imports, do nothing, and exit immediately.

### 7.5 JavaScript keywords used here

- **`import` (side-effect-only form)** — `import 'dotenv/config';` demonstrates that `import` doesn't always bind a name; sometimes a module is imported purely so its top-level code executes.
- **`import` (default form, ×2)** — `app` and `connectDB`.
- **`const`** — `PORT`, `MONGODB_URI`, and now `httpServer` are each declared once and never reassigned; the `start` function is declared with `async function`, not `const start = async () => {}` — either would work, `function` was chosen for a top-level, named, "this is the program's entry routine" declaration, matching `connectDB`'s style in section 3.
- **`||` (logical OR, used for a default value)** — `process.env.PORT || 3000` is a very common (if slightly imprecise — see 7.7) JavaScript idiom: it evaluates to the left side unless the left side is *falsy* (here, specifically `undefined` when unset), in which case it evaluates to the right side.
- **`async` / `await`** — `start` must be `async` to use `await connectDB(...)` inside it; this defers `app.listen` until the connection attempt has fully resolved.
- **Template literals (`` `Server listening on port ${PORT}` `` and `` `Port ${PORT} is already in use.` ``)** — backtick-delimited strings allowing `${expression}` interpolation, used here instead of string concatenation.
- **Arrow functions** — the `app.listen` success callback, and the new `httpServer.on('error', (error) => { ... })` callback, are both short, anonymous functions passed directly as arguments.
- **`if` / `else`** — the new error callback branches on `error.code` to decide which of two safe messages to print; both branches converge on the same `process.exit(1)`.
- **Method call on a returned object (`httpServer.on(...)`)** — not a new keyword, but worth naming: this line only works because `app.listen(...)` *returns a value* (the server object) that JavaScript lets you immediately call further methods on, once it's captured in a variable — exactly the same shape as `res.status(201).json(task)` chaining directly in `task.routes.js` (5.4), just spread across two statements here for clarity instead of one chained expression.

### 7.6 Express concepts used here

- **`app.listen(port, callback)`** — still the one Express method not used anywhere else in the project; it is the call that actually opens a TCP port and starts the process actively accepting incoming HTTP connections. Everything built in `app.js` (the middleware pipeline, the mounted router) only *takes effect* once this line runs — before it, `app` is a fully configured but entirely passive object. What's newly documented here is what `app.listen` *returns*: under the hood, Express creates a plain Node.js `http.Server` (via Node's own built-in `http` module) and calls that object's own `.listen(port, callback)` method for you, then hands that same `http.Server` object back as the return value of `app.listen`. This means `httpServer` in this file is **not** an Express-specific object at all — it is a raw Node.js server object, and everything about it from this point on (specifically, `.on('error', ...)`) is plain Node.js, not Express.
- **Node.js `EventEmitter` and the `'error'` event (beginner-level explanation).** Many built-in Node.js objects — including `http.Server` — are `EventEmitter`s: objects that can `.emit(...)` named events at arbitrary points in time, and that let other code `.on(name, callback)` to *subscribe* to one of those events, with `callback` invoked (possibly with arguments) every time that event fires. This is a fundamentally different shape from the request/response flow used everywhere else in this project: instead of "call a function and wait for a return value," it's "register interest in something that might happen later, zero or more times, and be notified when it does." A `Promise` (0.9) settles exactly once; an `EventEmitter`'s event can fire many times over the life of an object, or never. `http.Server` specifically emits `'listening'` when it successfully starts accepting connections (this is *why* the second argument to `app.listen` — the success callback — actually works: internally, Express registers that very callback as a one-time listener for the server's own `'listening'` event) and `'error'` when something goes wrong while trying to start or while already running. **A special Node.js rule makes this fix necessary, not just nice-to-have**: for the specific, built-in `'error'` event, if an `EventEmitter` emits it and **no listener has been registered**, Node.js treats that as serious enough to throw the error as an uncaught exception and crash the process — which is exactly the crash-with-a-stack-trace behavior verification observed *before* this fix (7.10, "before"). Adding `httpServer.on('error', ...)` is what satisfies that rule and gives this project's own code — not Node's default crash behavior — control over what happens next.
- **`EADDRINUSE` explained.** This is not an Express concept but a Node.js/operating-system one, surfacing here through Express's returned server object. When a program asks the operating system to listen on a specific TCP port, the OS enforces that only one process may be bound to a given port (on a given network interface) at a time. `EADDRINUSE` ("Error: Address In Use") is the standard POSIX/OS-level error code returned when a second process tries to bind to a port something else already holds — in this project, most commonly because an earlier `npm start`/`npm run dev` from a previous terminal session is still running in the background. Node.js surfaces this as the `.code` property (`'EADDRINUSE'`) on the `Error` object passed to the server's `'error'` event, which is exactly the property this fix checks.
- **Why the process exits non-zero (`process.exit(1)`) rather than continuing.** An HTTP server that failed to bind its port is not "running in a degraded way" — it is not running at all; no client can ever reach it. Continuing to execute past this point (for example, leaving the process alive so a supervisor's health check might catch it later) would misrepresent the process as potentially healthy when it fundamentally is not listening for anything. Exiting immediately, with a non-zero code — the same convention `connectDB` already uses for a failed database connection (section 3) — lets whatever started this process (a terminal, a process manager, an orchestrator) detect the failure immediately and unambiguously, exactly the same reasoning already documented for the database-connection failure path.
- **Why automatic port fallback was not selected.** A tempting alternative to crashing is to have the server quietly try the next port (`PORT + 1`, `PORT + 2`, …) until one is free, so `npm start` "just works" even with a collision. This was deliberately **not** implemented: a deployed or scripted environment (a reverse proxy, a container port mapping, a teammate's `curl` command, this project's own README examples) expects the API to be reachable at the **specific, configured** port — silently listening somewhere else would make the server *appear* to start successfully while actually being unreachable at the address everything else was told to use, turning an obvious, loud failure into a confusing, silent one. Failing fast and explicitly, and requiring a human (or a deployment script) to either free the port or choose a different one via `PORT` in `.env`, keeps the deployment configuration predictable — exactly the property the corrective-pass requirements called out by name.

### 7.7 Mongoose concepts used here

None directly in this file's own code — `server.js` never imports `mongoose`; it only calls the already-defined `connectDB` function (section 3), keeping the "how do we talk to MongoDB" detail fully encapsulated in `config/db.js`. The `EADDRINUSE` fix is entirely about the HTTP layer and has no interaction with Mongoose at all — by the time `httpServer.on('error', ...)` could ever fire, `connectDB` has already succeeded (7.9), so a port collision can never be mistaken for, or masked by, a database problem, and vice versa.

### 7.8 What happens in memory at runtime

This file's top-level `const`/`import` statements run exactly once, when Node first executes `node src/server.js`. Because of Node's ES Module resolution, all three `import` statements are resolved and their target modules fully executed **before** any of this file's own subsequent lines run — meaning by the time `process.env.PORT` is read, `dotenv/config`'s side effect has already populated `process.env`; by the time `connectDB`/`app` are referenced, `config/db.js`/`app.js` (and everything *they* transitively import — `mongoose`, `express`, `task.routes.js`, `task.model.js`) have already fully executed and returned their `export default` values. Node caches every module by its resolved file path — even though `app.js` is imported here and `task.routes.js` imports `task.model.js` which is imported nowhere else redundantly, each file's module code still only runs **once** for the life of the process, and every importer receives references to the exact same objects (the same `app`, the same `Task` model), not fresh copies. `start()` then runs; `app.listen(...)` creates one `http.Server` object, stored in `httpServer`, and immediately (still synchronously, in the same tick) `.on('error', ...)` attaches one listener function to it — both live for as long as the process does. After `start()` returns, the module-level code in `server.js` is finished — but the process itself does **not** exit, because the server keeps an active, open TCP socket registered with the operating system, which keeps Node's event loop alive indefinitely, waiting for connections (or, on a startup failure, for the single `'error'` event that leads straight to `process.exit(1)`).

### 7.9 Request flow (boot sequence, not per-request)

This is the very first code that runs, before any HTTP request can possibly be handled:

1. `node src/server.js` starts; Node begins resolving this file's `import`s.
2. `dotenv/config` runs first (as written), populating `process.env` from `.env`.
3. `app.js` runs fully — building the entire Express app and its middleware/routes (which itself pulls in `task.routes.js` → `task.model.js` → builds the `Task` model, and `mongoose`/`express` themselves).
4. `config/db.js` runs (just defines `connectDB`; does not connect yet).
5. Back in `server.js`: `PORT`/`MONGODB_URI` are read from `process.env`.
6. `start()` is called: `connectDB` attempts the real connection and **blocks progress of `start()`** (not the whole process — 0.4) until it resolves or the process exits.
7. Only on success: `app.listen(PORT, ...)` is called, immediately returning an `http.Server` object (`httpServer`) — at this instant, the OS-level bind/listen attempt is still in progress asynchronously; it has not yet succeeded or failed.
8. `httpServer.on('error', ...)` is attached, synchronously, before control returns to Node's event loop — this ordering matters: it guarantees the listener is already in place by the time the OS reports success or failure, so there's no window where a fast failure could be missed.
9. **From here, exactly one of two things happens**, decided by the operating system, not by this code:
   - **Success** → the server's `'listening'` event fires, Express's own internal listener for it invokes this file's success callback, `` `Server listening on port ${PORT}` `` is logged, and the process now sits idle, event-loop-driven, waiting for incoming connections — this is where section 8's per-request trace picks up.
   - **Failure** (most commonly `EADDRINUSE`) → the server's `'error'` event fires instead, `httpServer.on('error', ...)` runs, prints the appropriate safe message, and calls `process.exit(1)` — the process ends here; section 8 never begins for this run.

### 7.10 Failure scenarios

| Cause | Result (before this corrective pass) | Result (after this corrective pass) |
|---|---|---|
| `.env` missing entirely | `dotenv/config` does nothing harmful; `MONGODB_URI` being `undefined` fails inside `connectDB` (section 3) | Unchanged — this was never one of the two identified gaps |
| `PORT` already in use by another process | `app.listen` emitted an `'error'` event with no listener attached — Node's default behavior applied: an **uncaught exception**, full stack trace printed to the terminal, process exits non-zero *incidentally* (as a side effect of crashing), not intentionally | **Corrected and verified (section 10)**: `httpServer.on('error', ...)` catches the event; `error.code === 'EADDRINUSE'` is matched; a single concise line — `` Port <PORT> is already in use. `` — is printed (no stack trace, no `MONGODB_URI`, no other environment values); `process.exit(1)` terminates the process deliberately |
| Some other server startup error (e.g. `EACCES` binding a privileged port) | Same uncaught-exception crash as above | Falls into the `else` branch: `` Failed to start server: <error.message> `` is printed, then `process.exit(1)` — still no credentials, still a deliberate non-zero exit |
| Database connection fails | Handled entirely inside `connectDB` (section 3) — `process.exit(1)` runs before `app.listen` is ever reached | Unchanged — this path was already correct, and remains entirely separate from the `httpServer` error listener, which is only attached *after* a successful database connection |

### 7.11 Alternatives considered and why not chosen in Phase 1

- **Automatic port fallback** (trying `PORT + 1`, `PORT + 2`, … until one binds) — explicitly **not** implemented; see the dedicated explanation in 7.6 ("Why automatic port fallback was not selected"). In short: it would make the server's actual listening address unpredictable and silently diverge from the configured `PORT`, which is worse for deployment/debugging than a loud, immediate failure.
- **Graceful shutdown handling (`process.on('SIGTERM', ...)` to close the HTTP server and the Mongoose connection cleanly)** — deferred; Phase 1 has no deployment/orchestration context yet where an in-flight request could be cut off mid-response, so this was not prioritized. (This is unrelated to the `EADDRINUSE` fix — that fix concerns a server that never successfully started, not one being asked to shut down.)
- **A config-loading/validation module** that checks required environment variables are present and well-formed *before* attempting anything else, failing fast with a clear message like `"MONGODB_URI is required"` — not implemented in Phase 1; today a missing `MONGODB_URI` is only discovered indirectly, as a `mongoose.connect` failure. This is a reasonable, low-risk future improvement, and remains out of scope for this corrective pass, which addressed only the two specific gaps verification identified.
- **Top-level `await`** (calling `await connectDB(...)` directly at the top of the file, without wrapping it in `async function start() {}`) — modern Node.js *does* support top-level `await` in ES Modules. The `start()` wrapper was chosen instead purely for clarity: it gives the whole boot sequence one explicit, readable name, rather than leaving asynchronous top-level statements mixed in with the plain `const` declarations above them.
- **A dedicated `net`-module "is this port free?" pre-check before calling `app.listen`** (e.g. attempting a throwaway bind-and-close first) — not used, because it is inherently race-prone (another process could take the port in the gap between the check and the real `app.listen` call) and strictly more code than simply reacting to the `'error'` event `app.listen` already produces when a collision actually occurs; reacting to the real attempt's own outcome is both simpler and more correct than trying to predict it in advance.

---

## 8. End-to-end request flow: one full example traced across every file

This section follows a single concrete request through the entire system, referencing exact lines from the sections above. Example: a client runs

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk", "description": "2% milk"}'
```

1. **Before any request arrives** — the boot sequence from 7.9 has already run: `.env` was loaded, `mongoose.connect` succeeded, `app.listen(3000, ...)` opened the port. `app` (section 6), `router`/`Task` (sections 5, 4) all already exist in memory, built once and idle, waiting.
2. **TCP/HTTP layer** — curl opens a TCP connection to port 3000 and sends the raw HTTP request bytes (request line, headers, body). Node's underlying `http.Server` (created internally by `app.listen`) parses these bytes into a request/response pair and hands them to Express.
3. **Express builds `req`/`res`** and begins walking its middleware list (6.4) from the top.
4. **`express.json()` runs** — sees `Content-Type: application/json`, reads the request body stream to completion, parses `'{"title": "Buy milk", "description": "2% milk"}'` with `JSON.parse` under the hood, and assigns the resulting plain object to `req.body`. Calls `next()` internally to continue.
5. **Path matching** — `/api/tasks` matches the prefix registered in `app.use('/api/tasks', taskRoutes)` (6.4); control passes into the router from section 5 with the remaining path `''`/`'/'`.
6. **Router matching** — method `POST` + path `'/'` matches `router.post('/', ...)` (5.4); Express invokes that handler with `req`, `res`, `next`.
7. **Inside the handler** — `Task.create(req.body)` is called (5.4). Mongoose:
   a. Builds a new in-memory document from `{ title: 'Buy milk', description: '2% milk' }`.
   b. Runs setters: `trim` on `title` and `description` (no-op here, no surrounding whitespace); `completed` gets its `default: false` since it was omitted (4.4).
   c. Runs validators: `title` is present and non-empty, so `required` passes.
   d. Generates a new `_id` (a fresh ObjectId) and `createdAt`/`updatedAt` timestamps (4.4).
   e. Sends an `insert` command over the connection opened in `db.js` (section 3) to the real MongoDB server.
   f. **This is where the suspended-stack-frame behavior from 5.8 happens**: the handler's execution pauses at `await`; the Node.js thread is free to do other work; when MongoDB replies confirming the insert, the handler resumes.
8. **Response** — `res.status(201).json(task)` (5.4) serializes the created document (via its implicit `.toJSON()`, converting the internal `ObjectId`/`Date` objects to a plain JSON-safe string/ISO-date shape) and writes an HTTP response with status `201` and that JSON body onto the socket.
9. **Cleanup** — once the response is fully flushed, `req`/`res` for this request become unreachable and are eventually garbage-collected (7.8/5.8); `app`, `router`, `Task`, and the underlying Mongoose connection are untouched and remain ready for the next request.
10. **Client sees**:
    ```json
    HTTP/1.1 201 Created
    Content-Type: application/json

    {"_id":"...","title":"Buy milk","description":"2% milk","completed":false,"createdAt":"...","updatedAt":"...","__v":0}
    ```

A follow-up `GET /api/tasks/<that _id>` retraces steps 2–6 identically up through router matching, then follows the `router.get('/:id', ...)` branch (5.4): `mongoose.Types.ObjectId.isValid` passes, `Task.findById` awaits a query (not an insert) against MongoDB, finds the document, and responds `200` with it.

**Alternate path — malformed JSON.** If the same `curl` command's `-d` payload were syntactically broken JSON, step 4 above would change: `express.json()` would fail to parse it and call `next(err)` instead of `next()`. Execution would jump immediately to the malformed-JSON handler in `app.js` (6.4/6.9) — steps 5–9 above (path matching, router matching, the route handler, the Mongoose insert) would **never run at all** — and the client would receive `400` with `{"message":"Malformed JSON in request body"}` instead of the `201` shown in step 10. See 6.9 and 6.10 for the full trace and section 10 for the verified test result.

---

## 9. Failure scenario reference table (complete, cross-file)

| # | Trigger | File / line responsible | Status | Body shape | Verified |
|---|---|---|---|---|---|
| 1 | Server boots with unreachable/misconfigured MongoDB | `config/db.js` catch block | *(no HTTP response — process exits before listening)* | — process exit code `1`, safe log line | Yes |
| 2 | `express.json()` receives syntactically invalid JSON | `app.js` malformed-JSON handler (`err.type === 'entity.parse.failed'`) | `400` | `{ "message": "Malformed JSON in request body" }` | **Yes — corrected in this pass; see section 10** |
| 3 | POST/PATCH with missing or blank `title` | `task.routes.js` `ValidationError` branch | `400` | `{ "message": "Task validation failed: title: Title is required" }` | Yes |
| 4 | GET/PATCH/DELETE with a malformed `:id` | `task.routes.js` `ObjectId.isValid` check | `400` | `{ "message": "Invalid task id" }` | Yes |
| 5 | GET/PATCH/DELETE with a well-formed but nonexistent `:id` | `task.routes.js` `if (!task)` check | `404` | `{ "message": "Task not found" }` | Yes |
| 6 | Any request to a path outside `/api/tasks` | `app.js` 404 catch-all | `404` | `{ "message": "Route not found" }` | Yes |
| 7 | An unexpected error inside any route (e.g. MongoDB drops mid-request) | route's generic `catch` → `next(error)` → `app.js` generic error handler | `500` | `{ "message": "Something went wrong" }` | **Yes — re-verified directly in this pass by disconnecting the database mid-request; see section 10** |
| 8 | `PORT` already in use at startup | `server.js` `httpServer.on('error', ...)` (`error.code === 'EADDRINUSE'`) | *(no HTTP response — this is a boot-time failure, before any port is open)* | — process exit code `1`, safe log line (`` Port <PORT> is already in use. ``) | **Yes — corrected in this pass; see section 10** |

---

## 10. What we verified (proof, not assumption)

Every claim above about actual runtime behavior — not just what the code *appears* to do when read — was checked by actually running this exact code, not a simplified or hypothetical version of it. This section is split into the original Phase 1 verification and the corrective-pass verification that followed it, because the corrective pass specifically re-ran the original checks to prove nothing regressed, in addition to proving the two new fixes work.

### 10.1 Original Phase 1 verification

1. **Syntax** — every file in `src/` was checked with `node --check` and parses with no errors under `"type": "module"`.
2. **Dependency versions actually installed**: `express@4.22.2`, `mongoose@8.24.4`, `dotenv@16.6.1` (via `npm install` from the exact `package.json` in section 2.1).
3. **Connection-failure behavior** — the server was started with `MONGODB_URI` pointed at an address nothing listens on. Observed output: `MongoDB connection failed: connect ECONNREFUSED 127.0.0.1:1`, process exit code `1`. No credentials from the (deliberately included, fake) `baduser:badpass@` portion of the test URI appeared anywhere in the output — confirming section 3's "never log secrets" behavior.
4. **Full CRUD + edge cases**, run against a real, temporary, in-memory MongoDB instance (not a mock), driving the actual `app.js`/`task.routes.js`/`task.model.js`/`config/db.js` code exactly as written — all 12 checks passed (full list in 10.2, re-run identically).
5. **`timestamps: true` behavior** — confirmed directly: `createdAt` stays identical across a `findByIdAndUpdate` call, while `updatedAt` changes, matching the explanation in 4.4/4.7.
6. **Malformed-JSON behavior (original finding)** — confirmed directly: a request with a broken JSON body produced `500` with the generic message, via the central error handler, not a `400`. This was recorded at the time as a known Phase 1 limitation. **It has since been treated as a defect and corrected — see 10.2.**
7. **`EADDRINUSE` behavior (original finding, by code inspection)** — the original `server.js` never captured `app.listen`'s return value or listened for `'error'`, so a port collision was known to fall through to Node's default uncaught-exception crash. This was recorded as a known gap. **It has since been treated as a defect and corrected — see 10.2.**

### 10.2 Corrective-pass verification (this pass)

All of the following were executed after applying the two fixes in `src/app.js` and `src/server.js`, against the corrected code exactly as shown in sections 6.2 and 7.2:

1. **Syntax** — `node --check` re-run on all five files in `src/` (`config/db.js`, `models/task.model.js`, `routes/task.routes.js`, `app.js`, `server.js`); all pass with no errors.
2. **Full CRUD regression** — the same 12-check suite from the original verification was re-run, unmodified, against the corrected code, using a fresh in-memory MongoDB instance:
   - `POST /api/tasks` with a valid body → `201`, correct default `completed: false`. **PASS**
   - `POST /api/tasks` with a missing title → `400`. **PASS**
   - `GET /api/tasks` → `200`, array containing the created task. **PASS**
   - `GET /api/tasks/:id` for an existing id → `200`. **PASS**
   - `GET /api/tasks/:id` with a malformed id → `400`. **PASS**
   - `GET /api/tasks/:id` for a well-formed but nonexistent id → `404`. **PASS**
   - `PATCH /api/tasks/:id` updating `completed` → `200`, field actually changed. **PASS**
   - `PATCH /api/tasks/:id` clearing `title` to `""` → `400`. **PASS**
   - `PATCH /api/tasks/:id` for a nonexistent id → `404`. **PASS**
   - `DELETE /api/tasks/:id` for an existing id → `204`. **PASS**
   - `DELETE /api/tasks/:id` for an already-deleted id → `404`. **PASS**
   - `GET` an unrelated path → `404` via the catch-all. **PASS**
   - **Result: all 12/12 passed — no regression from the two fixes.**
3. **Malformed-JSON fix, verified directly** — a request with a syntactically broken JSON body (`{not valid json, definitely broken}}}`) was sent to `POST /api/tasks`. Observed, and checked programmatically:
   - Status code: **exactly `400`**.
   - `Content-Type` response header: **`application/json`**.
   - Response body: **exactly** `{"message":"Malformed JSON in request body"}` — one key, no extra fields.
   - Response body does **not** contain the raw malformed request body text, the string `"SyntaxError"`, a stack-trace pattern (`" at "`), the string `"node_modules"`, or the string `"body-parser"` — confirming no parser internals, stack trace or raw body leak to the client.
4. **Legitimate unexpected error still returns 500, verified directly** — with the app's real Mongoose connection deliberately disconnected mid-run (simulating an unexpected database failure, not a validation problem), a `GET /api/tasks` request was sent. Observed: status `500`, body exactly `{"message":"Something went wrong"}` — the same generic handler and message as before the corrective pass, confirming the new malformed-JSON handler's `next(err)` fallthrough does not interfere with this existing behavior.
5. **`EADDRINUSE` fix, verified directly with two real, separate OS processes** (not simulated): a first `node src/server.js` process was started against a real (in-memory) MongoDB on a fixed test port and confirmed listening (`Server listening on port 4321` observed in its log). A second, independent `node src/server.js` process was then started with the **same** `PORT` and `MONGODB_URI`. Observed for the second process:
   - Full output: `MongoDB connected` then `Port 4321 is already in use.` — nothing else.
   - **Exit code: `1`.**
   - No stack trace, no `"Emitted 'error' event"`/`"uncaught"` Node.js crash banner appeared anywhere in its output.
   - No occurrence of `mongodb://` (or any substring of the connection string/credentials) appeared anywhere in its output.
   - The **first** process was confirmed still alive and unaffected after the second process's failed attempt — the fix does not disturb an already-running instance.
6. **Cleanup** — both server processes and the temporary in-memory MongoDB instance used for this verification were stopped after the checks above completed; none were left running.
7. **Repository cleanliness** — the project directory was checked after verification: no log files, generated databases, or other temporary artifacts were left anywhere under `node-mongoose-mastery/` (all verification scripts and their output lived outside the project directory, in a separate scratch location, and were never copied in).
8. **`.env` / Git hygiene** — `.gitignore` still lists `.env` (unchanged by this pass), and no real `.env` file exists on disk in the project (only the placeholder `.env.example`, section 2.2) — so there is nothing containing real credentials for Git to ignore or accidentally track.
9. **No dependencies added** — `package.json` (section 2.1) is unchanged by this corrective pass; both fixes were implemented using only the `express`/`body-parser` behavior and Node.js `EventEmitter`/`http.Server` behavior already present before the pass began.

None of the behavioral claims in sections 3–9 are speculative; each traces back to one of the checks in 10.1 or 10.2 above.

---

## 11. Alternative architectural approaches not chosen in Phase 1

Beyond the file-specific alternatives already noted in each section, these are broader design choices deliberately deferred:

- **TypeScript instead of plain JavaScript.** TypeScript would catch a class of mistakes (wrong field names, wrong types passed to a route) at compile time instead of at request time. It was not chosen for Phase 1 because the explicit learning goal (see the top of the original spec) is to understand plain JavaScript, Express and Mongoose fundamentals first, without the additional concept of a build/type-checking step layered on top.
- **A service/controller/repository layered architecture** (separate files for "business logic" vs. "database access" vs. "HTTP handling") instead of putting Mongoose calls directly in route handlers. For a single resource with five simple operations, this would add indirection without a corresponding benefit; it becomes worth it once there are multiple resources, or business logic more complex than "call one Mongoose method."
- **A dedicated validation library** (`zod`, `joi`, `express-validator`) instead of relying on Mongoose schema validation alone. Mongoose's `required`/`type` checks are sufficient for Phase 1's three simple fields; a dedicated library earns its cost once validation rules stop mapping cleanly onto storage rules (e.g. "title must be unique across *active* tasks only," cross-field rules, or validating query-string parameters, which Mongoose has no concept of at all).
- **Centralized custom `Error` subclasses** (e.g. `class NotFoundError extends Error`) thrown from routes and interpreted by a smarter central error handler, instead of each route directly calling `res.status(...).json(...)` for its own known failure cases. This is a common pattern in larger Express apps; Phase 1 keeps each route's success/failure responses fully visible and local to that route instead, prioritizing readability for a first implementation over eliminating the repeated `res.status(400/404).json(...)` lines.
- **A different web framework** (Fastify, Koa) or a fuller framework (NestJS). Express was chosen specifically for its minimalism and ubiquity — every concept explained in this document (middleware, routers, `req`/`res`) transfers directly to reading almost any other Express codebase, which is the point of a foundations phase.
- **GraphQL instead of REST.** REST's direct method→verb, resource→URL mapping is simpler to reason about one endpoint at a time, which matches this phase's goal of understanding each individual request/response cycle deeply; GraphQL's single-endpoint, client-specified-query model solves a different problem (over/under-fetching across many related resources) that doesn't exist yet with one simple resource.
- **Pagination, filtering or sorting on `GET /api/tasks`.** `Task.find()` with no arguments returns the entire collection unconditionally. This is acceptable only because Phase 1 has no expectation of a large dataset; it is explicitly called out here as something that would need to change before this endpoint could be considered production-ready at scale.
- **Authentication/authorization.** There is currently no concept of a "user" at all — any client can create, read, update or delete any task. This is intentional: Phase 1's stated goal is CRUD + Mongoose fundamentals, and authentication is substantial enough to be its own later phase rather than something to bolt on partially here.
- **A dedicated test suite** (e.g. Jest/Vitest + Supertest) committed to the repository. The verification in section 10 was performed manually against this documentation's audit, using a temporary, uncommitted script and an in-memory MongoDB instance — proving the code's correctness, but a permanent, repeatable automated test suite (so a future code change can be checked against these same guarantees automatically) was intentionally left as a natural next step rather than part of Phase 1's own deliverables.
- **Containerization (Dockerfile/docker-compose)** for running the app and MongoDB together reproducibly. Left out of Phase 1 to keep the local setup to "install Node, install MongoDB (or point at a hosted instance), `npm install`, `npm start`" — the minimum needed to understand the code itself, without also having to understand containers.

---

## 12. Glossary

**ObjectId** — MongoDB's default type for the `_id` field: a 12-byte value, typically shown as a 24-character hexadecimal string.

**app.listen** — the Express method that opens a real TCP port and begins accepting HTTP connections.

**app.use** — registers a function into Express's middleware pipeline, optionally scoped to a path prefix.

**async / await** — JavaScript syntax for writing code that waits on a Promise-returning operation (like a database call) without blocking the rest of the program.

**Body-parsing middleware** — middleware (here, `express.json()`) that reads the raw HTTP request body and populates `req.body` with a parsed, usable value. Implemented internally by a bundled dependency called `body-parser`, which tags a parsing failure's `Error` object with `err.type = 'entity.parse.failed'` — the exact property `app.js`'s malformed-JSON handler checks (section 6.6).

**CommonJS** — Node.js's original module system (`require`/`module.exports`), distinct from ES Modules.

**Connection pool** — a set of reusable, already-open network connections a driver (here, MongoDB's driver, via Mongoose) maintains to avoid the cost of opening a new connection per operation.

**Document** — one MongoDB record; in Mongoose, a JavaScript object matching a Schema, with extra behavior like `.save()`.

**EADDRINUSE** — the operating-system error code for "this TCP port is already bound by another process." Surfaces in this project as `error.code` on the `'error'` event emitted by the `http.Server` object `app.listen(...)` returns, handled explicitly in `server.js` (section 7.6/7.9).

**Environment variable** — a value supplied to a process by its surrounding environment (shell, `.env` file via `dotenv`, hosting platform) rather than hardcoded in source, exposed in Node as `process.env.<NAME>`.

**ES Modules (ESM)** — the standard JavaScript module system using `import`/`export`, enabled here by `"type": "module"`.

**Event loop** — the mechanism that lets single-threaded Node.js handle many concurrent operations by not blocking on I/O. Distinct from an `EventEmitter` (below) — the event loop is Node's internal scheduling mechanism; an `EventEmitter` is a pattern used by ordinary objects within code running on top of it.

**EventEmitter** — a Node.js built-in object shape (many core objects, including `http.Server`, are one) that can `.emit(name, ...)` a named event at any time and let other code `.on(name, callback)` to be notified when it happens, zero or more times — unlike a Promise, which settles exactly once. This project listens for one such event, `'error'`, on the server object in `server.js` (section 7.6).

**Express** — the minimal Node.js web framework this project uses for routing and middleware.

**Middleware** — a function in Express's request-handling pipeline, of the form `(req, res, next)` or `(err, req, res, next)`.

**Mongoose** — the ODM library that maps JavaScript schemas/models onto MongoDB documents/collections.

**next()** — the function Express passes to every middleware, used to continue the pipeline (`next()`) or jump to error handling (`next(err)`).

**npm** — Node's package manager, used to install and manage third-party dependencies.

**Promise** — a JavaScript object representing a value that will be available (or an error that will occur) at some point in the future.

**req / res** — the request and response objects Express creates fresh for every incoming HTTP request.

**REST** — a convention for mapping application actions onto HTTP methods and URLs.

**Route parameter** — a named, dynamic segment of a URL path (e.g. `:id`), captured into `req.params`.

**Router** — an Express object holding a self-contained, mountable group of routes.

**Schema** — a Mongoose object describing a document's fields, types, defaults and validation rules.

**Status code** — the three-digit HTTP code summarizing the outcome of a request (`2xx` success, `4xx` client error, `5xx` server error).

**Validator** — a Mongoose rule (e.g. `required`) checked automatically before a document is saved (and, where explicitly enabled, before certain update queries).

**V8** — the JavaScript engine (also used in Chrome) that Node.js embeds to execute JavaScript code.
