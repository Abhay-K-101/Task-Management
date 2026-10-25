# Phase 3: API Professionalism

Phase 1 taught you CRUD. Phase 2 taught you architecture. Phase 3 teaches you the thing that separates a toy project from an API someone would actually trust in production: what happens at the edges — the input you don't control, and the output someone else's code will parse.

Nothing about the layers changed. Route → Controller → Service → Repository → Mongoose is exactly what it was. What changed is what each layer is now willing to accept, and what shape it hands back. Think of this phase less as "new features" and more as "growing up."

---

## 1. Why CRUD is not enough

A working `POST /api/tasks` that saves whatever it's given is a demo. It is not an API you'd hand to a frontend team, a mobile team, and a third-party integrator, and walk away from.

Here's what breaks, in practice, the first week someone else starts using Phase 2's API for real:

- A frontend form has a bug and submits `{"title": "a"}`. Phase 2 happily creates a one-character task. Nobody notices until a report is full of garbage rows.
- Someone builds a "mark as urgent" feature and needs a `priority` field. Nothing stops them from sending `priority: "URGENT!!"` — Mongoose's schema didn't know that field existed yet, so it just gets silently dropped, and the frontend engineer spends an hour debugging why their update "isn't saving."
- A mobile client sends `{"title": "Ship it", "isAdmin": true}` on an update — maybe by accident, maybe testing what sticks. Phase 2's Mongoose schema quietly ignores unknown fields. That's fine *today*, because there's no `isAdmin` field to accidentally set. It will not be fine the day there is one.
- Someone asks for "just the high-priority tasks," and the only answer Phase 2 has is "fetch all of them and filter in the frontend." That works with 12 tasks. It does not work with 12,000.

None of this means Phase 2 was wrong to build. It means Phase 2 solved *architecture* — where code lives — and Phase 3 solves *contract* — what the API promises to callers it doesn't control. Both matter. They're just different problems.

---

## 2. The problem of large datasets

`Task.find()` with no arguments returns every document in the collection. With 10 tasks, that's instant and nobody notices. With 1,000 tasks, the response is still fine, but it's a few hundred KB the client has to download and parse just to show a paginated table anyway. With 1,000,000 tasks, you have a genuinely different problem: MongoDB has to build a full result set, Node has to serialize a million objects to JSON, and the network has to move however many hundred megabytes that turns out to be — for a request where the user only ever wanted to see the first 20 rows.

Pagination isn't a nice-to-have UI feature. It's what keeps `GET /api/tasks` at roughly the same response time whether the collection has 10 rows or 10 million. Phase 3 makes `page`/`limit` load-bearing: the API now decides, server-side, exactly how many documents leave the database per request, instead of trusting every client to behave.

---

## 3. Filtering

Filtering answers one question: "of all the tasks, give me only the ones matching this exact condition."

```
GET /api/tasks?completed=true
GET /api/tasks?status=done
GET /api/tasks?priority=high
GET /api/tasks?completed=true&priority=high
```

Each of these becomes one key in the Mongoose query object the repository builds — `{ completed: true }`, `{ status: 'done' }`, `{ priority: 'high' }` — and MongoDB ANDs multiple keys in the same query object together automatically, which is exactly why `completed=true&priority=high` "just works" without any special combination logic: it's still one query object, just with two keys instead of one.

The interesting design decision isn't the query — it's *where the validation happens*. `?status=archived` isn't a real status. Should the API silently return zero results (as if "archived" tasks exist but there happen to be none), or should it say "that's not a real filter value"? Phase 3 does the second: an unrecognized `status`/`priority` value, or a `completed` value that isn't exactly `"true"`/`"false"`, is rejected with `400` before a query ever runs. Silently returning an empty array for a typo'd filter is exactly the kind of thing that looks like a bug report waiting to happen ("why does my filter return nothing?") — failing loudly is more honest.

---

## 4. Search

Filtering finds exact matches. Search finds *approximate* ones — "something with 'node' in the title," not "the title is exactly 'node'."

```
GET /api/tasks?search=node
```

matches `"Node basics"`, `"Deploy node service"`, and `"Investigate node memory leak"` — a partial, case-insensitive match, not an exact one. Under the hood this is a MongoDB regex query: `{ title: { $regex: "node", $options: "i" } }`. The `i` option is what makes it case-insensitive; without it, `"NODE"` and `"node"` would be treated as different strings, which is almost never what a search box user wants.

Here's the tradeoff nobody mentions in the tutorial version of this feature: a regex is not just a string-matching tool, it's a tiny programming language, and the search term comes from the client. If a user searches for `"node.*"` or `"(a+)+"`, characters like `.`, `*`, `(`, and `+` mean something special to a regex engine — they don't just match themselves. At best this produces a confusing false match (`.` matching *any* character, so `"node.txt"` would match a title containing `"nodeXtxt"`). At worst, certain pathological patterns can make a regex engine spend a very long time on a single match attempt — a category of bug real APIs have shipped and regretted. Phase 3's repository escapes every regex special character in the search term before building the query, so a search for `"node.*"` looks for the literal three characters `.`, `*` — a search, not an accidental micro-language a client can steer.

This is also why an empty or whitespace-only `?search=` is quietly treated as "no search filter" rather than "match every title" — a query someone almost certainly didn't mean to send shouldn't change the result set.

---

## 5. Sorting

```
GET /api/tasks?sortBy=createdAt&order=desc
GET /api/tasks?sortBy=title&order=asc
```

`sortBy` picks the field, `order` picks the direction. In real usage these map directly onto product decisions: a task dashboard's default view is almost always `sortBy=createdAt&order=desc` — newest work first, because that's what a person just did and wants to confirm. An alphabetical picklist for a dropdown wants `sortBy=title&order=asc`. A "what changed most recently" audit view wants `sortBy=updatedAt&order=desc`.

Only three fields are sortable in Phase 3 — `createdAt`, `updatedAt`, `title` — and only two directions exist. Both are intentionally a fixed, small list, not "whatever field name you send us": letting a client sort by an arbitrary, unindexed field is how a database quietly gets asked to do a full collection scan on every request, and a request for `?sortBy=$where` or some other MongoDB operator-looking string is exactly the kind of input a real database should never see passed through unchecked. `?sortBy=notAField` or `?order=sideways` both return `400` — the same "fail loudly on nonsense" philosophy as filtering.

---

## 6. Pagination

```
?page=1&limit=10   → the first 10 tasks
?page=2&limit=10   → the next 10 tasks
?page=3&limit=5    → tasks 11-15, five at a time
```

Picture 23 total tasks, `limit=10`:

```
[ 1  2  3  4  5  6  7  8  9  10 ]  ← page=1
[ 11 12 13 14 15 16 17 18 19 20 ]  ← page=2
[ 21 22 23 ]                       ← page=3 (partial)
```

`page` and `limit` are what the client asks for. `skip` is the number Mongoose actually needs to build the query underneath — "skip the first N documents, then take the next `limit`" — computed as `(page - 1) * limit`. A client never sends `skip` directly in this API; it's an implementation detail the repository derives, the same way a restaurant host doesn't ask "which table number do you want," they ask "how many people," and work out the seating themselves.

It's worth naming the two most common ways this goes wrong for a beginner. First, off-by-one errors: it's tempting to compute `skip = page * limit`, which looks almost right and is subtly wrong — for `page=1`, that would skip the first `limit` documents instead of zero, silently hiding the first page's worth of results forever. The `(page - 1)` is doing real work, not decoration. Second, confusing `page`/`limit` (what the *client* thinks in) with `skip`/`limit` (what the *database* thinks in): a client reasoning in pages doesn't want to know that page 3 with a page size of 10 means "skip 20" any more than a diner wants to know their table's exact GPS coordinates — that translation is exactly the kind of detail a repository exists to hide.

Two numbers are non-negotiable: `page` must be an integer `>= 1` (there is no "page 0" or "page -3"), and `limit` is capped between `1` and `100` — a client cannot ask for a million rows per page just because nothing stops them from typing a big number, which would defeat the entire point pagination exists to solve (Section 2). Every response also carries metadata so a client never has to guess:

```json
"pagination": {
  "page": 1,
  "limit": 10,
  "totalCount": 23,
  "totalPages": 3,
  "hasNextPage": true,
  "hasPrevPage": false
}
```

`totalCount` and `totalPages` let a UI render "page 1 of 3." `hasNextPage`/`hasPrevPage` let it disable a "Next" button without the client doing its own arithmetic — small, but it's the difference between an API that makes the client do work and one that does the work once, centrally, for every client.

---

## 7. Validation: why trust boundaries matter

Everything in Sections 3–6 assumes the query parameters and request body are basically sane. They aren't, by default — they're just text a client sent over the network, and a client is not always a well-behaved frontend written by your own team. It might be a buggy integration, an old mobile app version nobody updated, or someone deliberately poking at your API to see what it does.

A **trust boundary** is the line where data crosses from "something arrived from outside" to "something our code is about to act on." Everything on the far side of that line — `req.body`, `req.params`, `req.query` — is adversarial by default, not because every caller is malicious, but because the cost of assuming otherwise, once, is too high to risk. A few concrete examples of what "trusting it anyway" costs:

- **Mass assignment.** If an update endpoint saves whatever fields it's given, and a `role` or `isAdmin` field ever gets added to the schema for internal use, an update request that includes `{"role": "admin"}` would silently work — not because anyone built an admin-escalation feature, but because nobody explicitly said which fields a client is allowed to touch. Phase 3's update whitelist (`title`, `description`, `completed`, `priority`, `status` — nothing else) means an unrecognized field is rejected with `400` *today*, while the stakes are low, establishing the habit before the stakes are ever high.
- **Regex/ReDoS injection.** Covered in Section 4 — user input treated as a regex pattern instead of a literal string can be abused to hang a server on a single request.
- **Unbounded queries.** Covered in Section 6 — no `limit` cap means a client can force the server (and the network, and its own memory) to handle an arbitrarily large response.
- **Malformed data reaching the database anyway.** Even a well-behaved client has bugs. A three-character minimum on `title` isn't there because attackers send empty titles — it's there because *someone's* client, someday, will have a bug that submits one, and the API should say "no" clearly (`400`, a specific message) rather than silently storing junk that shows up as a mystery later.

Phase 3's `task-validation.middleware.js` sits exactly on this boundary — it runs **before** the controller, which runs before the service, which runs before the repository ever builds a query. Bad input is rejected as early and as cheaply as possible, before any code that assumes clean data ever sees it. Mongoose's schema (`minlength`, `maxlength`, `enum`) enforces the same rules a second time, at the database layer — not because the middleware might be wrong, but because it's the one guarantee that holds even if some future code path writes to this collection without going through the middleware at all. Two layers agreeing on the same rule isn't redundant; it's the difference between a rule that's *usually* true and one that's *always* true.

---

## 8. Keeping derived fields honest: the `completed` / `status` invariant

A task has both a `completed` boolean and a `status` (`todo`/`in-progress`/`done`) — two fields telling you overlapping things about the same underlying fact. Whenever a system stores the same fact two different ways, those two representations can drift apart unless something actively keeps them in sync. Left unchecked, that drift is exactly the kind of bug that's invisible in testing and infuriating in production: a task shows up in a "completed" filter but its status column still says "in-progress," and two different parts of the UI disagree with each other about the same task.

**The invariant.** `status: "done"` always means `completed: true`. `status: "todo"` or `status: "in-progress"` always means `completed: false`. There is no valid task where these disagree.

Because a client can supply either field, both, or neither, the service applies one consistent rule set:
- Supply only `status` → `completed` is derived from it.
- Supply only `completed` → `true` derives `status: "done"`; `false` pulls status back to `"todo"` **only if it was `"done"`**, and leaves an existing `"in-progress"` status alone (going back to `false` doesn't mean going back to square one).
- Supply both, and they disagree (e.g. `status: "done"` with `completed: false`) → `400`, not a silent guess about which one you "really" meant.

Three examples:

```
POST { "status": "done" }                          -> stored as { status: "done", completed: true }
PATCH { "completed": false }  (on a "done" task)    -> becomes { status: "todo", completed: false }
PATCH { "status": "done", "completed": false }      -> 400: "completed and status contradict each other"
```

**Why the service, not the model or the middleware.** The validation middleware checks that `status` is a real status and `completed` is a real boolean — shape and allowed values, nothing more; it has no idea what the *combination* should mean, and Section 7 already draws that line deliberately. The Mongoose model could enforce this with a custom validator, but a schema-level check only sees the document being written — it can't easily tell "the client only sent `completed`, so derive `status`" apart from "the client explicitly sent both, and they happen to already agree," and it has no clean way to reject with the same `400`-plus-message shape the rest of this API already uses. Deciding what a partial update *means* — including reaching back to the task's current `status` to know whether "in-progress" should survive a `completed: false` — is a workflow decision, which is precisely what Section 2 of the [Phase 2 architecture doc](phase-02-layered-architecture.md) put in the service's job description. The repository still only builds and runs queries; it receives an already-consistent document either way and never has to know this rule exists.

---

## 9. Request journey: `GET /api/tasks?page=2&limit=10&priority=high`

1. **`src/app.js`** — `express.json()` runs (no body on a GET, so this is a no-op), then the request is routed to `/api/tasks`.
2. **`src/routes/task.routes.js`** — `GET /` has no validation middleware in front of it (query-parameter validation is a service concern in this architecture, not a middleware one — see Section 7's note on where each kind of check lives); it goes straight to `taskController.listTasks`.
3. **`src/controllers/task.controller.js`** — `listTasks` reads `req.query` (`{ page: '2', limit: '10', priority: 'high' }` — note these arrive as strings; HTTP query strings have no concept of numbers or booleans) and calls `taskService.listTasks(req.query)`. It does not interpret any of these values itself.
4. **`src/services/task.service.js`** — this is where the real work happens:
   - `buildFilter` sees `priority: 'high'`, checks it against the allowed list (`low`/`medium`/`high`), and builds `{ priority: 'high' }`.
   - `buildSort` sees no `sortBy`/`order`, and defaults to `{ sortBy: 'createdAt', order: 'desc' }`.
   - `buildPagination` converts the *strings* `'2'` and `'10'` into the *numbers* `2` and `10`, checks `page >= 1` and `1 <= limit <= 100`, and returns `{ page: 2, limit: 10 }`.
   - All four of these throw a tagged `400` error immediately if anything looks wrong — none of this reaches the repository unless it's already valid.
5. **`src/repositories/task.repository.js`** — `findAll` receives the *already-decided* `{ filter: { priority: 'high' }, sortBy: 'createdAt', order: 'desc', page: 2, limit: 10 }`, computes `skip = (2 - 1) * 10 = 10`, and runs `Task.find({ priority: 'high' }).sort({ createdAt: -1 }).skip(10).limit(10)` alongside `Task.countDocuments({ priority: 'high' })` for the total count.
6. **Back up the chain** — the repository returns `{ tasks, totalCount }`; the service computes `totalPages`/`hasNextPage`/`hasPrevPage` and returns `{ tasks, pagination }`; the controller wraps it as `{ success: true, data: tasks, pagination }` and sends `200`.
7. **If any step in 4 had failed** — say `limit=500` — the thrown error (tagged `statusCode: 400`) would have skipped the repository and the rest of the controller entirely, landing in `src/middleware/error.middleware.js`, which turns it into `{ success: false, message: "limit must be an integer between 1 and 100" }`.

Notice the controller never touched a query object, and the repository never decided whether `500` was too large a limit — each layer did exactly one job, exactly like Phase 2 described, just with more jobs to do now.

---

## 10. Responses: why consistency matters

Every successful response now has the same skeleton. A single task:

```json
{ "success": true, "data": { "_id": "...", "title": "...", "priority": "medium", "status": "todo", ... } }
```

A collection:

```json
{ "success": true, "data": [ /* tasks */ ], "pagination": { "page": 1, "limit": 10, "totalCount": 23, "totalPages": 3, "hasNextPage": true, "hasPrevPage": false } }
```

And every error, from every layer — a validation failure, an invalid id, a not-found, malformed JSON, or a genuine server failure — looks like exactly one shape:

```json
{ "success": false, "message": "..." }
```

The value of this is almost entirely invisible when everything is working, and enormous the moment it isn't. A frontend developer integrating against this API can write one piece of logic — `if (response.success) { use response.data } else { show response.message }` — and never have to special-case "oh, but the delete endpoint returns something different" or "oh, but validation errors have a different shape than not-found errors." Every error message in this API is deliberately short and free of stack traces or internal details (Phase 1's original security requirement, unchanged) — `success: false` tells the caller *that* something went wrong, `message` tells them roughly *what*, and neither ever tells them *how the server is built*.

---

## 11. Checkpoint quiz

1. What's the difference between filtering and search, in one sentence?
2. Why does `?status=archived` return `400` instead of an empty list?
3. What MongoDB query shape does `?completed=true&priority=high` produce?
4. Why is the search term's regex escaped before it's used in a query?
5. What does the `i` option do in `{ $regex: term, $options: 'i' }`?
6. Why is an empty `?search=` treated as "no search," not "match everything"?
7. Why are only three fields (`createdAt`, `updatedAt`, `title`) allowed for `sortBy`?
8. What HTTP status do `?sortBy=notAField` and `?order=sideways` return?
9. In the pagination formula `skip = (page - 1) * limit`, what does `skip` mean?
10. Why is `limit` capped at 100 instead of left unbounded?
11. Name two fields in the pagination metadata that let a client render "Next"/"Previous" buttons without doing math.
12. What is a "trust boundary," in your own words?
13. What is mass assignment, and which Phase 3 rule specifically prevents it?
14. Why does the update endpoint reject `{"hackField": true}` even though nothing bad would happen with today's schema?
15. Name one reason a three-character minimum on `title` exists that has nothing to do with attackers.
16. Where does query-parameter validation for `GET /api/tasks` live — the middleware file, the controller, or the service? Why?
17. What does the Mongoose schema's `enum`/`minlength`/`maxlength` validation do that the request-validation middleware doesn't already guarantee?
18. What does every successful response have in common, regardless of endpoint?
19. What does every error response have in common, regardless of which layer produced the error?
20. Why does a consistent response envelope matter more to a frontend developer than to the API itself?

### Answers

1. Filtering finds exact matches on a known value (`status=done`); search finds partial, approximate matches on free text (`search=node`).
2. Because `"archived"` isn't a real status value — silently returning zero results would look like a bug ("why is my filter empty?") instead of clearly telling the caller the value itself was invalid.
3. `{ completed: true, priority: 'high' }` — one query object with two keys, which MongoDB ANDs together automatically.
4. So that regex metacharacters in the user's search term (`.`, `*`, `(`, etc.) are treated as literal characters to search for, not as regex syntax — preventing both confusing false matches and potential denial-of-service via a pathological pattern.
5. It makes the match case-insensitive, so `"NODE"` and `"node"` are treated as the same text.
6. Because a client almost certainly didn't intend "return everything" when they left the search box blank — treating blank as "no filter" avoids surprising behavior.
7. Because letting a client sort by an arbitrary field risks an unindexed, slow query, or a client passing something that isn't a real field name at all — a small fixed allow-list is both safer and predictable.
8. `400`.
9. The number of documents to skip over before starting to collect results — i.e., how far into the full result set this page begins.
10. So a single request can't force the server to build and return an arbitrarily large response, which would defeat the entire performance reason pagination exists.
11. `hasNextPage` and `hasPrevPage` (also acceptable: `totalPages`, combined with `page`).
12. The line where data crosses from "outside the system, not controlled by us" to "about to be acted on by our code" — everything past that line should be checked, not assumed safe.
13. Mass assignment is when an API accepts and saves whatever fields a client sends, even ones the client shouldn't be able to set (like a future `role` field) — Phase 3's update whitelist (`title`, `description`, `completed`, `priority`, `status` only) prevents it by rejecting any other field outright.
14. Because the habit of "only named fields are allowed" needs to already exist *before* a sensitive field like `role` or `isAdmin` is ever added — waiting until there's something dangerous to protect is too late.
15. A three-character minimum also catches ordinary client bugs (an accidental single-character submission from a broken form, for example), not just adversarial input.
16. The service — because deciding what's a valid filter/sort/pagination value is a business rule about the data, not an HTTP concern (controller) or a query-building concern (repository); the repository still builds the actual Mongoose query once the service has already decided the values are valid.
17. It guarantees the rule holds even for a write that doesn't go through the middleware at all (a future script, a different endpoint, a bug that skips the middleware) — it's the backstop that makes the rule *always* true, not just usually true.
18. `{ "success": true, "data": ... }` — a single object under `data` for one resource, an array plus a `pagination` object for a collection.
19. `{ "success": false, "message": "..." }` — regardless of which layer or which kind of failure produced it.
20. Because a frontend only has to write one branch of logic — check `success`, then either use `data` or show `message` — instead of learning a different response shape for every endpoint and every kind of failure; the API only has to get this right once, centrally, instead of every caller re-discovering the inconsistency independently.
