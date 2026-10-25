# Phase 2: Learning Software Architecture — The Layered Refactor

Phase 1 built a working Task API and explained every line of it. Phase 2 does not add anything a user can see — no new endpoints, no new fields, no new behavior. Every request still gets exactly the same response it got before. What changes is entirely internal: *how the code is organized* so it can keep growing without turning into a mess.

If you run the same Postman requests from Phase 1 against Phase 2, you should not be able to tell anything happened at all. That's the point.

---

## 1. What problem are we solving?

In Phase 1, `task.routes.js` did everything for a request: it read `req.body`, checked whether an `:id` looked like a valid MongoDB id, called a Mongoose method, decided whether the result meant `200`, `404`, or `400`, and wrote the response. For five simple endpoints, that was fine — everything fit on one screen per route.

Now imagine this API keeps growing, the way real projects do:

- Someone asks: "Can only the person who created a task mark it complete?" That's a rule about *who is allowed to do what* — not about talking to MongoDB. Where does that check go? In Phase 1's structure, it would get bolted onto the route, right next to the database call, because there's nowhere else to put it.
- Someone asks: "Can we also expose tasks over a small CLI tool, not just HTTP?" Now the "create a task" logic needs to run from somewhere that has no `req`/`res` at all — but in Phase 1, that logic is *welded* to the Express route function that expects them.
- Someone asks: "Can we write a test for 'creating a task with no title fails' without needing a real MongoDB running?" In Phase 1, the only way to call that logic is through the whole Express route — which means the test needs a real HTTP server and a real database, just to check one rule.

None of these are exotic requests. They are the *first* three things almost any growing application eventually needs. Phase 1's structure doesn't forbid them — but it makes every one of them require surgery on a file that mixes "talk to HTTP" and "talk to MongoDB" and "decide what's allowed" into one paragraph. Phase 2 pulls those three concerns apart *before* they pile up, while the app is still small enough that untangling them is easy.

---

## 2. The big picture

Picture a food-delivery company, because the shape of the problem is the same: someone places an order, and the order has to travel through several people before food comes out the other end, each with one job.

```
Customer               places an order
   │
   ▼
Reception Desk         → Route            takes the order, sends it to the right department
   │
   ▼
Manager                → Controller       reads the order, decides who should handle it, replies to the customer
   │
   ▼
Chef                   → Service          knows the recipe — the actual rules of the business
   │
   ▼
Warehouse Worker       → Repository       is the only one who goes into the storage room
   │
   ▼
Storage Room           → MongoDB          where the ingredients (data) actually live
```

**The Route is the reception desk.** It doesn't cook, it doesn't decide anything — it just looks at what came in ("a POST to `/api/tasks`") and points it at the right person. A reception desk that started chopping vegetables would be absurd; a route that starts querying MongoDB is the same kind of absurd, just less obviously so.

**The Controller is the manager.** The manager takes the order from reception, translates it into something the kitchen understands, and — once the kitchen is done — packages the result back up for the customer. The manager doesn't personally cook, and doesn't personally go fetch ingredients from the storage room. In code, the controller reads `req.body`/`req.params`, calls exactly one service function, and turns whatever comes back into `res.status(...).json(...)`.

**The Service is the chef.** The chef knows the *recipe* — the actual rules of the business ("a task must have a title," and later, things like "only the owner can mark their own task complete"). The chef doesn't care whether the order came in by phone, by app, or by a walk-in customer (HTTP, a CLI tool, a scheduled job) — recipes are the same regardless of how the order arrived. In code, the service has never heard of `req` or `res`; it just takes plain values in and returns plain values out.

**The Repository is the warehouse worker.** This is the only person with a key to the storage room. Nobody else — not the manager, not the chef — goes in there themselves; they ask the warehouse worker to fetch or store something. In code, the repository is the only file that imports Mongoose queries like `Task.find()` or `Task.create()`. If MongoDB were ever swapped for a different database, this is the only file that would need to change.

**MongoDB is the storage room itself** — where the data physically lives, indifferent to how it's asked for.

This is why the rule "requests flow one direction, down through the layers" matters: the reception desk never shouts directly into the storage room, and the warehouse worker never decides what a customer is charged. Each layer only ever talks to the one directly below it.

---

## 3. Request journey: `POST /api/tasks`, step by step

Say a client sends:

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy milk"}'
```

1. **`src/server.js`** is already running — it connected to MongoDB and opened the port at boot (unchanged from Phase 1). It does nothing per-request; it just keeps the process alive.
2. **`src/app.js`** — Express's `express.json()` middleware parses the body into `req.body = { title: "Buy milk" }`, then hands the request to whichever router matches `/api/tasks`.
3. **`src/routes/task.routes.js`** — matches `POST /` (mounted under `/api/tasks`) and forwards straight to `taskController.createTask`. The route itself makes no decisions — it is one line: `router.post('/', taskController.createTask)`.
4. **`src/controllers/task.controller.js`** — `createTask` reads `req.body`, calls `taskService.createTask(req.body)`, and waits.
5. **`src/services/task.service.js`** — `createTask` has no extra rules to apply yet (Phase 1's only rule, "a title is required," is enforced by the schema itself), so it simply calls `taskRepository.create(data)` and returns whatever comes back.
6. **`src/repositories/task.repository.js`** — `create` is the *only* place in the whole request that mentions Mongoose: `Task.create(data)`. This runs the schema's validation and defaults, and saves the new document.
7. **`src/models/task.model.js`** — defines what a valid Task looks like (unchanged from Phase 1); the repository leans on this schema, it doesn't reimplement it.
8. **Back up the chain** — the created document returns from repository → service → controller. The controller sends `res.status(201).json(task)`.
9. **If anything goes wrong anywhere in steps 4–7** — a missing title, a malformed id, MongoDB being unreachable — the nearest `catch` calls `next(error)`, and the request jumps straight to `src/middleware/error.middleware.js`, which is the *only* place that decides what HTTP status code an error becomes (see Section 4).

Notice what *doesn't* happen: the controller never sees a Mongoose document type, the service never sees `req`/`res`, and the route never makes a decision at all. Each file only had to know about the one file below it.

---

## 4. File-by-file tour

**`src/routes/task.routes.js`**
*Purpose:* map an HTTP method + path to a controller function.
*Should do:* one line per endpoint, wiring a path straight to a controller.
*Should never do:* touch `req.body`, call Mongoose, or contain an `if` statement deciding a status code.

**`src/controllers/task.controller.js`**
*Purpose:* translate between HTTP and the rest of the app.
*Should do:* read `req.params`/`req.body`, call one service function, send the response, forward errors with `next(error)`.
*Should never do:* import Mongoose or the `Task` model, or contain business rules (e.g. "what counts as a valid id").

**`src/services/task.service.js`**
*Purpose:* hold the business rules and decide what should happen.
*Should do:* validate that an id is well-formed before bothering to look it up, decide that "not found" is a real problem worth reporting, and (in a later phase) hold rules like ownership checks.
*Should never do:* reference `req`, `res`, status codes, or anything Express-specific — a service function should make sense if called from a test, a script, or a future CLI tool, not just from a web request.

**`src/repositories/task.repository.js`**
*Purpose:* the only file that speaks Mongoose.
*Should do:* thin wrappers around `Task.find()`, `Task.findById()`, `Task.create()`, `Task.findByIdAndUpdate()`, `Task.findByIdAndDelete()`, plus the one small `isValidId()` helper that recognizes a well-formed MongoDB id.
*Should never do:* decide what an empty result *means* (that's the service's call) or format an HTTP response.

**`src/models/task.model.js`**
Unchanged from Phase 1 — still just the `title`/`description`/`completed` schema with timestamps. The model was already the right shape; only the files *around* it needed reorganizing.

**`src/middleware/error.middleware.js`**
*Purpose:* the single place that turns any error, from any layer, into the correct HTTP status and a safe message.
*Should do:* recognize a handful of known shapes — a malformed-JSON parsing error, a Mongoose validation error, a service error carrying a `statusCode` — and fall back to a generic `500` for anything else, logging the detail server-side only.
*Should never do:* contain business logic, or let a raw error message/stack trace reach the client.

**`src/app.js` / `src/server.js`**
Unchanged in role from Phase 1: `app.js` assembles the Express app and its middleware pipeline (now pointing at the new router and the new error middleware); `server.js` connects to the database, then starts listening, with the same `EADDRINUSE` handling as before.

---

## 5. Before vs. after

| | Phase 1 | Phase 2 |
|---|---|---|
| Where a request is handled | One function per route, in `task.routes.js` | Spread across route → controller → service → repository, each with one job |
| Where Mongoose is called | Directly inside each route | Only inside `task.repository.js` |
| Where "is this id valid?" lives | Repeated in three separate route handlers | Decided once, in the service, using one repository helper |
| Where error → status-code mapping lives | Scattered: partly per-route, partly in `app.js` | Centralized in `error.middleware.js` |
| To add a new business rule | Edit a route handler that also does HTTP and DB work | Edit only the service — nothing else needs to change |
| To swap MongoDB for something else (hypothetically) | Rewrite every route | Rewrite only the repository |

The advantage isn't that Phase 2 does *more* — it's that each future change now has one obvious, small place to go, instead of a route file that has to be re-read in full every time.

---

## 6. Why testing becomes easier

No test code is being added in Phase 2 — but it's worth seeing *why* this shape makes testing dramatically simpler later, because that's a large part of why this refactor is worth doing at all.

In Phase 1, testing "does creating a task with no title fail correctly?" meant starting a real Express server, sending a real HTTP request, and hitting a real (or in-memory) MongoDB — three moving parts, just to check one rule.

In Phase 2, the service function `getTaskById` doesn't know or care whether `taskRepository` is *really* talking to MongoDB. That means a test can hand it a **mock repository** instead — a fake object with a `findById` function that just returns a canned value directly, with no database involved at all:

```js
const fakeRepository = {
  isValidId: () => true,
  findById: async () => null, // pretend "not found"
};
```

Calling the service with that fake repository lets you check "does the service correctly report *not found* as a 404-shaped error?" in a few milliseconds, with nothing but plain JavaScript objects — no server, no database, no network. The same idea applies one level up: a controller can be tested with a **mock service** that returns a fixed value, to check "does the controller send the right status code?" without caring whether the business logic behind it is real or fake. Each layer can be tested in isolation, because each layer only depends on the shape of the one below it, not its real implementation.

---

## 7. Common beginner mistakes

- **The controller calling `Task.findById()` directly**, "just this once," because it's faster than going through the service. This quietly breaks the one rule that makes the repository useful at all — that it's the *only* place Mongoose is mentioned. Once one controller does it, there's no reason the next one won't too.
- **Business logic sneaking into the route**, like an `if` statement in `task.routes.js` deciding something about the request before it even reaches a controller. If a route file has an `if`, that's usually a sign the logic belongs in the service.
- **Copy-pasting the same query into two repository functions** instead of writing one and calling it twice. The repository is exactly the place to *avoid* duplicate queries — that's most of its value.
- **A service reaching back up for `req` or `res`** ("just to check a header") because a service function needs a piece of information from the request. This breaks the promise that a service can be called from anywhere, not just from HTTP. Instead, whatever the service needs should be passed in as a plain argument by the controller.
- **Putting the error-status decision back in the controller** ("if error.message includes 'not found', send 404") instead of letting it flow to `error.middleware.js`. Once that logic is duplicated in one controller, it tends to get duplicated, slightly differently, in every other one.

---

## 8. Checkpoint quiz

1. Which layer is the only one allowed to call `Task.find()`?
2. Why should a route file contain no `if` statements deciding a status code?
3. What does the controller do with the value a service function returns?
4. Can a repository function return data without knowing anything about HTTP? Why does that matter?
5. In the food-delivery analogy, who is the "chef," and what does that role correspond to in code?
6. Where does "is this a well-formed MongoDB id?" get decided in Phase 2, and why not in the controller?
7. What is the one job of `src/middleware/error.middleware.js`?
8. If you wanted to add a rule like "only the task's owner can delete it," which single file would you change?
9. Why does the service layer never import `express`?
10. What would go wrong if a controller imported the `Task` Mongoose model directly?
11. Why does testing a service function not require a running MongoDB instance?
12. What is a "mock repository," in one sentence?
13. Name one thing that must behave identically in Phase 2 as it did in Phase 1.
14. Why is `task.model.js` almost unchanged between Phase 1 and Phase 2?
15. What is the direction requests are allowed to flow through the layers — and what's not allowed?

### Answers

1. The repository (`task.repository.js`) — it's the only file that imports and calls Mongoose model methods.
2. Because deciding a status code is a judgment about business meaning (was this valid? found? allowed?) — a route's only job is to point a path at a controller, nothing more.
3. It turns that value into an HTTP response — success becomes `res.status(...).json(...)`, and a thrown error is forwarded with `next(error)` instead.
4. Yes — a repository function just returns a plain JavaScript object (or `null`/an array). That matters because it means the same repository could be called from a website, a CLI tool, or a test, not just from an HTTP request.
5. The service is the chef — it holds the actual business rules (the "recipe"), independent of how the order arrived.
6. In the service layer, using a small helper the repository exposes (`isValidId`) — not in the controller, because "is this id valid" is a decision about business rules, and the controller's job is only to shuttle data between HTTP and the service.
7. To be the single place that turns any error, from any layer, into the correct HTTP status code and a safe response body.
8. The service (`task.service.js`) — ownership is a business rule, not an HTTP concern or a raw database query.
9. Because a service must make sense when called from anything — a web request, a script, a future CLI — not only from Express; importing `express` would tie it to HTTP.
10. It would mean the controller now depends on Mongoose directly, breaking the rule that only the repository does — a future database swap would then require rewriting controllers too, not just the repository.
11. Because the service only calls whatever repository object it's given — in a test, that can be a fake object returning canned values, with no real database involved at all.
12. A fake stand-in for the real repository, used in a test, that returns fixed values instead of actually querying MongoDB.
13. Any of: the five endpoints and their paths/methods; the status codes for success, validation failure, invalid id, not-found, and unexpected errors; the response body shapes. (Phase 2 changed none of these.)
14. Because the *shape of the data* was never the problem Phase 2 was solving — only how the surrounding code was organized around it.
15. Strictly downward — route → controller → service → repository → MongoDB. A lower layer never calls back up into a higher one (a repository never calls a controller, a service never touches `req`/`res`).

---

Phase 2 changed no behavior a client can observe. What changed is that the next feature — an ownership check, a new business rule, a real test suite — now has an obvious, small place to go, instead of one more `if` bolted onto a route file.
