# Phase 4: Automated Testing — Thinking Like an SDET

Phase 1 taught CRUD. Phase 2 taught architecture. Phase 3 taught API professionalism. Phase 4 teaches the discipline that makes the first three trustworthy over time: **automated tests that outlive the person who wrote the feature.**

This isn't a reference manual for the 321 tests in `tests/`. It's the thinking behind them — so the next person (possibly future-you) can extend the suite correctly instead of copying patterns without understanding why they're shaped that way.

---

## 1. From manual checks to a safety net

Every earlier phase in this project was verified by hand: a script spun up an in-memory MongoDB, fired a batch of requests, printed PASS/FAIL, and was thrown away. That process proved something real — Phase 3's filtering, search, sorting and pagination genuinely worked the day they were written. But a script living in a scratch directory proves nothing about *tomorrow*. It can't run itself before the next commit. Nobody reviewing a future pull request will read it, because it isn't there to read.

A committed test suite is different in kind, not just in permanence. It's **executable documentation**: `it('rejects a title shorter than 3 characters', ...)` tells a new contributor the rule exists, exactly what triggers it, and what "correct" looks like — all without them reading `task-validation.middleware.js` first. And it's a **regression net**: if someone "simplifies" the `completed`/`status` reconciliation next month and breaks the case where an in-progress task should survive `completed: false`, a scratch script from three months ago won't catch it. `tests/integration/task.update.test.js` will, immediately, by name: `'completed: false preserves an existing "in-progress" status'`.

The manual scripts did their job. This suite is what makes their findings permanent.

---

## 2. The test pyramid for this project

```
              ▲
             ╱ ╲      few:   contract/regression tests (the full HTTP surface)
            ╱───╲
           ╱     ╲    more:  integration tests (Express → Mongo, real wiring)
          ╱───────╲
         ╱         ╲  many:  unit tests (one function, no I/O)
        ╱───────────╲
```

The exact ratio here (321 tests, roughly 40% unit / 60% integration, with the integration layer *also* serving as the contract layer) is a consequence of this app being small and mostly logic-in-service-plus-thin-everything-else — not a rule to copy elsewhere. What matters is the principle underneath the shape: **run the cheapest test that can actually catch the bug you're worried about.** A missing `if` in `buildPagination` is a unit-test-shaped risk — no database needed, no HTTP needed, just call `listTasks` with a mocked repository. Whether `Task.find().skip().limit()` actually returns the right MongoDB documents is an integration-shaped risk — no amount of mocking proves that. Pick the level by the risk, not by habit.

---

## 3. Unit vs. integration vs. API contract tests

| | What's real | What's mocked | Proves | Can't prove | Example here |
|---|---|---|---|---|---|
| **Unit** | The function under test | Everything it calls (the repository) | The function's own logic is correct given any input | That the real database behaves the way the mock assumes | `tests/unit/task.service.test.js` — `updateTask` fetches the existing task, reconciles, and rejects contradictions *before* calling `updateById` — proven with a mocked `taskRepository` |
| **Integration** | Express, the real router, real Mongoose, a real (in-memory) MongoDB | Nothing, except one deliberately-simulated failure in `task.errors.test.js` | The whole stack actually works together — a filter really filters, a regex really gets escaped | Nothing hidden — but a slow/expensive request here costs milliseconds, not microseconds | `tests/integration/task.list.test.js` — seeds real documents, asserts a real, escaped MongoDB regex query returns the right ones |
| **Contract/regression** | Same as integration | Same as integration | The *shape* of the API — status codes, envelope, field names — hasn't drifted from what Phase 3 approved | Internal correctness beyond the observable response | Every `expect(res.body).toEqual({ success: false, message: '...' })` assertion across the integration files |

In this project the contract layer isn't a separate folder — it's the same integration tests, read with a different intent. A test that checks `res.body.data.priority === 'high'` is proving behavior; the *same* test, run automatically on every future change, is what stops someone from silently renaming `priority` to `taskPriority` and shipping it.

---

## 4. Why Supertest doesn't need a real port

`src/app.js` exports the configured Express **application object** — middleware, routes, error handlers, fully assembled, but never told to listen on anything. `src/server.js` is the only file that calls `app.listen(...)`, and only it decides *when* (after `connectDB` succeeds) and *on which port* (`process.env.PORT`).

```js
import app from '../../src/app.js';
import request from 'supertest';

const res = await request(app).get('/api/tasks');
```

`request(app)` hands Supertest the app object directly. Supertest knows that an Express app is really just a function `(req, res) => {...}`, and it can drive that function with fabricated in-process request/response objects — no TCP socket, no `0.0.0.0:PORT`, no `localhost`. Every assertion in this suite is really a direct function call wearing an HTTP-shaped costume.

This is *why* the integration suite has zero relationship to whatever's running on port 3000 in a terminal next to it. `npm run dev`'s `nodemon` process, if one happens to be running, is a completely different Node process, with its own `app.listen()`, talking to whatever `MONGODB_URI` is in `.env`. The test suite never imports `server.js`, never calls `.listen()`, and never knows that other process exists. Killing the suite can't touch it; the suite running can't touch it either — they're not the same address space, not the same port, not the same database.

---

## 5. Safe database isolation

`tests/setup/global-setup.js` starts exactly one `mongodb-memory-server` instance — a real, temporary `mongod` process with its own randomly-assigned port and its own throwaway data directory — once, before any test file runs:

```
globalSetup.setup()        →  one in-memory mongod starts, URI stored in
                               process.env.TEST_MONGODB_URI (this run only)
   │
   ▼
each test file's beforeAll →  connectTestDatabase() connects Mongoose to
                               that same shared instance (via the real
                               production connectDB())
   │
   ▼
each test's beforeEach     →  clearTestDatabase() deletes every document —
                               every test starts from a known-empty database
   │
   ▼
each test file's afterAll  →  disconnectTestDatabase() closes that file's
                               Mongoose connection
   │
   ▼
globalSetup.teardown()     →  the shared mongod process is stopped, once,
                               after every file has finished
```

`MONGODB_URI` from the developer's real `.env` is never read anywhere in `tests/`. There is no code path by which the suite could reach a real local or remote database even by accident — `connectTestDatabase()` only knows about `process.env.TEST_MONGODB_URI`, a value that exists only inside a running test process and points at a MongoDB instance that never existed before this run and won't exist after it.

Test *independence* comes from the `beforeEach` wipe, not from having a separate database per test (that would be far slower for no extra safety here): whatever test A inserted is gone before test B starts, so B's assertions can never accidentally depend on A having run first — and Section 11 covers what happens when this guarantee is the thing actually under suspicion.

---

## 6. How to read a good test

```js
it('status "done" alone stores completed: true', async () => {
  const res = await post({ title: 'Task', status: 'done' });      // Arrange + Act
  expect(res.body.data).toMatchObject({ status: 'done', completed: true }); // Assert
});
```

**Arrange**: `post({ title: 'Task', status: 'done' })` — a minimal, valid request body, with exactly one interesting fact (`status: 'done'`, `completed` deliberately omitted). Everything not relevant to this test is left at its simplest possible value.

**Act**: the same line *is* the act — `post(...)` sends the real HTTP request through the real app.

**Assert**: one focused expectation, on the one outcome this test exists to prove — that omitting `completed` when `status: 'done'` is supplied correctly *derives* `completed: true`, rather than leaving it at the schema default of `false`.

Notice what's absent: no comment restating what the code obviously does, no assertion about `title` or `_id` (a different test already owns those), no cleverness. The test's name is a complete sentence describing a behavior; the body is the shortest path to proving that one sentence true or false.

---

## 7. Test design techniques, with this API

- **Positive testing** — does the right thing happen with good input? `POST { title: 'Buy milk' } → 201`.
- **Negative testing** — does the right *rejection* happen with bad input? `POST { title: 'ab' } → 400`.
- **Boundary values** — the edges of a valid range, on both sides: title lengths **2, 3, 100, 101** (2 and 101 fail, 3 and 100 pass — the off-by-one is exactly where bugs hide); pagination limits **0, 1, 100, 101**.
- **Equivalence partitioning** — you don't need to test title lengths 4 through 99 individually; they're all in the same "obviously valid" partition as 3 and 100. One representative from each partition (too-short / valid / too-long) is enough.
- **State-transition testing** — this API has a real state machine (`todo` / `in-progress` / `done`, linked to `completed`). `tests/integration/task.update.test.js` tests the transitions directly: `done + completed:false → todo`, `in-progress + completed:false → in-progress` (unchanged — the interesting case isn't the transition, it's proving one *doesn't* happen).
- **Pairwise / permutation testing** — filter, search, sort and pagination are four independent dimensions; testing all of them in isolation doesn't prove they *combine* correctly. `tests/integration/task.list.test.js`'s `permutations` block exists specifically to catch a bug that only shows up when, say, a filtered-and-searched result is paginated and the count is wrong for the filtered set instead of the whole collection.
- **Regression testing** — every test in this suite, the moment it's committed, becomes a regression test for whatever it currently proves.
- **Error guessing** — the search-escaping tests exist because an experienced tester's instinct says "what if someone searches for a literal `.`?" before any bug report ever arrives. See section 4 of the Phase 3 doc for why that instinct matters here specifically.

---

## 8. Mocking without lying to yourself

`tests/unit/task.service.test.js` mocks the repository:

```js
vi.mock('../../src/repositories/task.repository.js', () => ({
  default: { isValidId: vi.fn(), findById: vi.fn(), updateById: vi.fn(), /* ... */ },
}));
```

This is deliberate, not a shortcut. The service's job is *decisions* — is this id well-formed, do these fields contradict, what does "not found" become — and none of that requires a real database to prove. Mocking the repository lets the test ask "does `updateTask` call `updateById` with the reconciled data?" without also asking "does MongoDB's `findByIdAndUpdate` work?" (a question Mongoose's own test suite already answers, and section 7 of the Phase 1 doc explicitly warns against re-proving).

The integration suite mocks *nothing* about the stack itself — real Express, real Mongoose, a real (if temporary) MongoDB — because the question there is different: does the *wiring* work? A mocked repository can't tell you whether `Task.find(query)` actually understood the filter object `task.service.js` built for it.

The line to watch for is **testing the mock instead of the behavior**. `expect(taskRepository.findById).toHaveBeenCalledWith(id)` is meaningful — it proves the service fetches the current task before reconciling (a decision that matters). Asserting the *exact number and order* of every internal call a refactor might reasonably reshuffle is not — it makes the test brittle without making it more honest. Prefer asserting what the function *returns* or *throws*, and only assert a specific call when the call itself — not just its result — is the thing under test.

---

## 9. Test data and determinism

`tests/setup/test-data.js` holds two seeding strategies, and the difference between them is the whole lesson:

- `seedTasks(...)` inserts through the real Mongoose model, sequentially — fine for filter/search/pagination tests, where *which* document is which doesn't matter, only that a title/status/priority combination exists.
- `seedTasksWithTimestamps(...)` bypasses Mongoose's automatic `createdAt`/`updatedAt` and writes explicit, one-minute-apart Date values through the native driver. Sort-order tests need this: two documents created microseconds apart on a fast machine (or, worse, in the same millisecond) make "sorted by createdAt" genuinely ambiguous. The fix is never `await sleep(1000)` between inserts — that's slow, and still not guaranteed safe on a loaded CI machine. Controlling the timestamp directly makes the ordering deterministic by construction, not by hoping the clock cooperates.

The rest of the discipline is smaller but adds up: `FILTER_SEED` and `PERMUTATION_SEED` are small, hand-written, and readable at a glance — not thousands of randomly generated rows that would make a failing assertion's "why" require its own investigation. `beforeEach(clearTestDatabase)` means no test can pass *only because* an earlier test happened to run first. And a test's name is written to be the failure message: when `'search is case-insensitive'` fails, you already know what broke before reading a single line of the stack trace.

---

## 10. Coverage without coverage theatre

```
Statements   : 99.02% ( 204/206 )
Branches     : 100%   ( 123/123 )
Functions    : 100%   ( 39/39 )
Lines        : 99%    ( 198/200 )
```

Four different questions, not one number: **statements** (was this line executed at all?), **branches** (was *each side* of every `if`/`&&`/`||` exercised — the true path *and* the false path?), **functions** (was this function called at all?), **lines** (statements, counted by source line instead of by AST node). Branch coverage is the one that matters most for a validation-and-error-handling-heavy codebase like this one: a validator with 100% statement coverage can still have never once exercised its *rejection* path, if every test happened to send valid input. This suite's branch number is 100% precisely because the "invalid" half of every `if` — missing title, unknown field, invalid enum, contradictory invariant — has its own dedicated test, not just the "valid" half.

The two uncovered statements are `src/config/db.js`'s `catch` block — the `console.error` + `process.exit(1)` that only runs when `mongoose.connect` itself rejects. Reaching it would mean either mocking the `mongoose` package (fragile, low value for four lines of code) or actually calling `process.exit` inside a test process (which would kill the test runner). That exact failure path already has strong, empirical, documented manual verification from the Phase 1 corrective pass — a case where 100% automated coverage genuinely isn't worth chasing, and saying so honestly is more useful than a fragile mock that exists only to move a percentage.

**100% coverage proves every line ran. It proves nothing about whether the assertions on that line were any good.** A test with no `expect()` at all can drive a function to 100% coverage while proving nothing. Coverage tells you where to *look* for missing tests; it is not a substitute for reading them.

---

## 11. Failure guide

- **Tests don't terminate** — almost always an open handle: a Mongoose connection or the in-memory `mongod` never closed. Check that every `describe` block with a `beforeAll(connectTestDatabase)` has a matching `afterAll(disconnectTestDatabase)`, and that `global-setup.js`'s `teardown()` is actually wired into `vitest.config.js`'s `globalSetup`.
- **Memory-server startup failure** — usually a first-run binary download (`mongodb-memory-server` fetches a real `mongod` the first time it's used) failing on disk space or network. Free disk space and re-run; the binary is cached under `node_modules/.cache/mongodb-memory-server/` afterward.
- **Port mistakes** — shouldn't be possible here (section 4), but if a test ever imports `src/server.js` instead of `src/app.js`, or calls `.listen()` itself, that's the bug to look for first.
- **Environment leakage** — if a test ever seems to see real data, check for a stray `process.env.MONGODB_URI` reference; the suite should only ever read `process.env.TEST_MONGODB_URI`, set once by `global-setup.js`.
- **Flaky sort/time test** — see section 9: switch the seed to `seedTasksWithTimestamps`, never a `sleep`.
- **A test passes alone but fails in the full suite** — this is not hypothetical; it happened during this phase's own development. Running eight separate `mongodb-memory-server` instances (one spawned and torn down per file) was reliable individually but intermittently produced unrelated failures — a *different* random request timing out or mis-responding — only when the full suite ran back-to-back, on a machine under heavy disk pressure. The fix was architectural, not a retry: `global-setup.js` now starts **one** shared in-memory MongoDB for the entire run instead of eight, cutting real-process spawn/teardown churn by 7/8. If you ever see this pattern — reliable alone, occasionally flaky together — suspect shared external process/resource contention before suspecting your test's logic; a test that fails for a different, unrelated reason each time it fails is almost never a logic bug.
- **Stale mock affecting another test** — a `vi.spyOn(...)` left un-restored leaks its fake behavior into the next test that touches the same method. `tests/integration/task.errors.test.js` calls `vi.restoreAllMocks()` in `afterEach` specifically so this can't happen, even if an individual test forgets its own cleanup.

---

## 12. Test matrix summary

| Behavior | Unit | Integration | Contract |
|---|---|---|---|
| Request-body shape (types, lengths, enums, unknown fields) | ✅ `task-validation.middleware.test.js` | ✅ (via HTTP) | ✅ (status + envelope) |
| `completed`/`status` reconciliation & contradiction rejection | ✅ `task.service.test.js` | ✅ `task.create/update.test.js` | ✅ |
| Query-parameter validation (filter/sort/pagination values) | ✅ `task.service.test.js` | ✅ `task.list.test.js` | ✅ |
| Filtering, search (+ regex escaping), sorting correctness | — (needs real Mongo) | ✅ `task.list.test.js` | ✅ |
| Pagination arithmetic (`totalPages`/`hasNextPage`/...) | ✅ (formula, mocked count) | ✅ (real count) | ✅ |
| Not-found / invalid-id translation to 404/400 | ✅ `task.service.test.js` | ✅ all integration files | ✅ |
| Malformed JSON, unknown routes, unexpected 500s | — | ✅ `task.errors.test.js` | ✅ |
| Response envelope consistency (`success`/`data`/`pagination`/`message`) | — | ✅ every integration file | ✅ |

---

## 13. Checkpoint quiz

1. Why is a committed test suite more valuable than a temporary verification script, even if both catch the same bug today?
2. What does "executable documentation" mean, concretely, for a test like `'rejects a title shorter than 3 characters'`?
3. In the test pyramid, what determines whether a given risk belongs at the unit or integration level?
4. What does an integration test in this suite have "real" that a unit test does not?
5. What can an integration test prove that a unit test, no matter how thorough, cannot?
6. How does `request(app)` avoid binding a real TCP port?
7. Why does the test suite never interact with whatever is running on `localhost:3000`?
8. What starts exactly once for the whole test run, and what starts once *per file*?
9. Why is `MONGODB_URI` from `.env` never read by any test?
10. What makes tests independent of each other, given they all share one MongoDB instance?
11. In the Arrange/Act/Assert shape, what should Arrange contain that isn't relevant to the test's one behavior?
12. Give an example of a boundary-value pair from this suite, and say why both sides are needed.
13. What is equivalence partitioning, and why doesn't this suite test every title length from 4 to 99?
14. What real behavior does the `done + completed:false → todo` test prove that a plain "is this valid?" test would not?
15. Why does the service unit test mock the repository instead of hitting a real database?
16. What's the difference between asserting a mock "was called with X" and asserting a mock "was called," and why does that distinction matter?
17. Why does `seedTasksWithTimestamps` write directly through the native driver instead of `Task.create()`?
18. What does 100% branch coverage prove about a validator that 100% statement coverage does not?
19. Why are `src/config/db.js`'s two uncovered lines a deliberate, documented gap rather than an oversight?
20. A test passes when run alone but fails intermittently in the full suite — what should you suspect first, and why?

### Answers

1. A script only proves the bug is caught *today*, by whoever remembers to run it; a committed test runs automatically on every future change and fails loudly the moment the behavior regresses.
2. It tells a reader the rule exists and exactly what triggers it, without them needing to read the middleware's source first — the test name plus its assertion *is* the specification.
3. Whether proving it requires real I/O (a database, the network). If not, it's cheaper and just as conclusive as a unit test; if it does, only an integration test can actually prove it.
4. A real Express app, a real router, real Mongoose, and a real (if temporary and in-memory) MongoDB — nothing in the request path is faked.
5. That the pieces actually work *together* — e.g., that a filter object the service builds is one Mongoose actually understands, not just one the service's own logic believes is well-formed.
6. Supertest treats the Express app as a plain function and drives it with in-process fake request/response objects — no socket, no port, no `app.listen()` involved.
7. Because the suite only ever imports `src/app.js`, never `src/server.js`, and never calls `.listen()` itself — the two have no shared process, port, or database connection.
8. The in-memory MongoDB process itself starts once, in `global-setup.js`, for the whole run; each test *file* opens and closes its own Mongoose connection to that same shared instance.
9. Because `connectTestDatabase()` only ever reads `process.env.TEST_MONGODB_URI`, a value that exists only for the duration of a test run and is set by `global-setup.js`, never derived from `.env`.
10. `clearTestDatabase()` runs in a `beforeEach`, wiping every collection before every single test — so no test can start with data another test left behind.
11. Everything *not* under test, set to the simplest valid value — so a reader can immediately see which single fact the test actually cares about.
12. Title length 2 (must fail) and 3 (must pass) — because the minimum-length rule is defined as "at least 3," and the off-by-one is exactly where a `<` vs `<=` mistake would hide.
13. Grouping inputs that exercise the same code path so one representative stands in for the whole group; titles 4–99 all take the same "valid, no boundary involved" path as title length 3, so testing them individually would add cost without adding evidence.
14. That an *existing* value the service didn't just receive (the task's current status) correctly influences the outcome — a static "is this input shape valid?" check can't reveal a bug in logic that depends on prior state.
15. Because the service's own job — deciding, not storing — doesn't require a real database to verify, and mocking it isolates "is the service's logic correct" from "does MongoDB behave as expected," which is a separate, already-covered question.
16. "Called with X" proves a specific decision was made (e.g., which id was looked up); "was called" only proves some call happened, proving far less — overusing the weaker form can let a real bug (calling with the wrong argument) pass silently.
17. Because Mongoose's own `timestamps: true` behavior would assign `createdAt`/`updatedAt` automatically, at real insertion time — which can leave two documents only microseconds apart and make a sort-order assertion genuinely flaky; writing explicit values removes the ambiguity entirely, without sleeping.
18. That the *rejection* path — the `if` branch that fires on invalid input — was actually executed by a test, not just the success path; 100% statements could still mean every test happened to send valid data.
19. Because covering them would require either mocking the `mongoose` package itself (fragile, for four lines) or calling `process.exit` inside the test process (which would kill the runner) — and the behavior is already verified manually, with evidence, in the Phase 1 corrective pass.
20. Suspect shared external resource contention (a database process, disk, CPU) before suspecting the test's own logic — a test that fails for a *different*, unrelated reason each time it fails, and passes reliably alone, is the signature of an environment problem, not a bug in what the test asserts.
