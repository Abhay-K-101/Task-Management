# Phase 5: Authentication, Authorization and Ownership

Phase 1 built CRUD. Phase 2 arranged it into layers. Phase 3 made it behave like a professional API. Phase 4 wrapped it in a test suite that proves all of that still works. Every one of those phases shared a quiet assumption that this phase finally removes: **that everyone using the API is the same person.**

Until now, `GET /api/tasks` returned every task in the database, to anybody who asked. That is fine for a single-user toy and catastrophic for anything else. Phase 5 introduces users, proves who is calling, and makes each task belong to exactly one of them.

This document is the reasoning behind those changes. It is not a line-by-line tour of the code — the code has its own comments for that.

---

## 1. Why authentication exists

Strip away the jargon and an API endpoint is a function anyone on the internet can call. `DELETE /api/tasks/:id` is a function that destroys data. Before Phase 5, the only thing standing between a stranger and every task in the database was the fact that they had not guessed the URL.

Authentication answers one question: **who is making this request?** Not "are they allowed to do it" — that comes next — just *who*. HTTP itself cannot answer this. It is a stateless protocol: each request arrives with no memory of the one before it, no inherent notion of a session, and no way to know that the `POST /api/tasks` it is handling now came from the same person as the `POST /api/auth/login` a minute ago.

So identity has to be carried *in the request itself*, every single time. That is the constraint that shapes everything below: the client must present some proof of identity on each call, and the server must be able to check that proof cheaply and confidently.

The naive answer — send the username and password with every request — is where this chapter begins, and Section 5 explains why a token is a better answer.

---

## 2. Authentication vs. authorization

These two words are constantly used interchangeably, and the distinction is the single most useful idea in this phase.

| | Authentication | Authorization |
|---|---|---|
| Question | Who are you? | What are you allowed to do? |
| Happens | First | After authentication |
| Fails with | `401 Unauthorized` | `403 Forbidden` (usually — see below) |
| In this codebase | `src/middleware/auth.middleware.js` | `src/services/task.service.js` + `src/repositories/task.repository.js` |
| Concretely | "This request carries a valid token for user `abc123`." | "User `abc123` may read task `xyz789`, because they own it." |

The HTTP status names are unhelpful: `401 Unauthorized` is actually about *authentication* ("you have not proven who you are"), and `403 Forbidden` is the authorization one ("I know who you are, and no"). It is a decades-old misnaming that everyone has simply learned to live with.

The two failures are genuinely different. A missing token is an authentication failure — the server has no idea who is calling. A valid token belonging to someone who does not own the task is an *authorization* failure — the server knows exactly who is calling and is refusing anyway.

This API deliberately answers `404` rather than `403` for that second case, and Section 7 explains why that apparent inaccuracy is the more secure choice.

---

## 3. Passwords should never be stored

The single most important rule in this phase: **your database must never contain a password.**

Not encrypted, either. Encryption is reversible by design — it exists so that something can be decrypted later, which means a key exists, which means the key can be stolen alongside the data. If your database contains encrypted passwords and an attacker gets both the dump and the key, they have every password.

The reason this matters so much more than it first appears is **password reuse**. If this task API stored plaintext passwords and leaked them, the damage would not be limited to some tasks getting deleted. A meaningful share of users will have used that same password on their email account, and an email account is the master key to everything else — every "forgot password" link in their life lands there. A breach of a toy task app becomes a breach of someone's entire online identity.

So the requirement is stronger than "keep passwords safe". It is: **be structurally incapable of revealing a password, even to yourself, even under a full database compromise.**

That rules out storing the password in any recoverable form. What the server stores instead is the output of a one-way function — something derived from the password that can verify a future guess without containing the password itself. That is hashing.

You can see this requirement expressed directly in the schema (`src/models/user.model.js`): the field is called `passwordHash`, not `password`. There is no schema path a plaintext password could even be written to.

---

## 4. Hashing and bcrypt

A hash function turns input into a fixed-size output, and cannot be run backwards. Verifying a login means hashing the submitted password and comparing it to the stored hash — at no point does the server recover the original.

But not every hash function is suitable, and the reason is speed.

`SHA-256` is a fine hash function and a *terrible* password hash, because it is fast — deliberately so, since it is designed for checksumming files. Modern hardware computes billions of SHA-256 hashes per second. An attacker holding a stolen database does not need to reverse the hash; they simply guess, hashing common passwords until an output matches. At billions of guesses per second, every password in the top few million is found essentially instantly.

**bcrypt is deliberately, configurably slow.** That is its entire point. Its cost factor sets how much work each hash takes, and each increment *doubles* it:

```js
const BCRYPT_COST = 12;                                  // src/services/auth.service.js
const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
```

At cost 12 a single hash takes a few hundred milliseconds. For a legitimate login that is invisible — it happens once, and nobody notices 200ms. For an attacker, it is devastating: the same hardware that could try billions of SHA-256 guesses per second manages a handful of bcrypt guesses per second. An offline attack that would have taken seconds now takes lifetimes.

The cost factor is a dial you can turn up as hardware improves, which is why bcrypt has aged well. It is chosen here to be a deliberate speed limit, not despite being slow but *because* of it.

bcrypt also **salts** automatically. A salt is random data mixed into each hash, so that two users with the identical password get completely different stored hashes:

```
alice → $2b$12$K7L1OJ0/9K2vC...   ← same password
bob   → $2b$12$9pQr2Xm.4Nn8vB...  ← different hash
```

Without salting, identical hashes would visibly reveal that two users share a password, and — far worse — an attacker could precompute one giant table of hashed common passwords (a "rainbow table") and crack an entire database in one pass. Salting makes every hash a separate problem. The salt is stored inside the hash string itself, which is why a bcrypt hash is a self-contained 60-character value carrying its own algorithm marker, cost, and salt:

```
$2b$12$y5qRH275CXYPVtHYXohT2OXT9BMNpGkNzo.yyQtWHZnfVcjYJmy2e
└┬┘└┬┘└──────────┬─────────┘└───────────┬──────────────────┘
 │   │            salt                   hash
 │   └── cost factor (12)
 └────── algorithm (bcrypt, 2b variant)
```

One practical footnote: bcrypt only considers the first 72 bytes of input. Rather than silently ignoring anything beyond that — which would mean two different long passwords could unlock the same account — `auth-validation.middleware.js` rejects passwords longer than 72 characters outright.

---

## 5. JWT explained

Hashing solved storage. It did not solve the per-request identity problem from Section 1.

Re-sending the password with every request would mean the password travels the network constantly, and the server would run a deliberately-slow bcrypt comparison on *every* API call — turning bcrypt's greatest strength into a self-inflicted denial of service. What is needed is something the client can present cheaply and the server can verify cheaply, which the user obtains *once* by proving their identity the expensive way.

That is a token. This project uses a **JSON Web Token**.

A JWT is three base64url-encoded sections joined by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 . eyJzdWIiOiI2NGI3ZjFmMSJ9 . dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
└──────────── header ──────────────┘   └────── payload ──────┘   └──────────── signature ─────────────────┘
      algorithm & type                    the claims               proof the server issued this
```

**The critical thing to understand: a JWT is signed, not encrypted.** The payload is *encoded*, not hidden. Anyone holding the token can decode and read it — no key required, no cleverness involved. Try it in a browser console with `atob()`.

Two consequences follow directly, and both are implemented here:

1. **Never put secrets in a payload.** No password, no hash, nothing sensitive. This project's payload carries the user id and nothing else:
   ```js
   jwt.sign({ sub: String(userId) }, getSecret(), { expiresIn: getExpiresIn() });
   ```
2. **The signature is what matters.** It is computed from the header, the payload and a secret only the server knows. Change so much as one character of the payload and the signature no longer matches. An attacker can freely *read* a token and freely *edit* it — but cannot produce a valid signature for their edit without the secret, so the server rejects it. `tests/unit/auth.middleware.test.js` proves exactly this with a token whose payload is swapped while the original signature is kept.

This is why `JWT_SECRET` is required and has **no fallback value**:

```js
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('JWT_SECRET is not configured');
  }
  return secret;
}
```

A hardcoded development default is one of the most common ways a project ships a forgeable token to production: the moment the secret is in the repository, anyone who has seen the source can mint a valid token for any user. `src/server.js` refuses to start without one, so a misconfigured deployment fails immediately and loudly rather than at the first login attempt.

### Expiry, and what this project does not have

Tokens expire. This one defaults to **one hour** (`DEFAULT_EXPIRES_IN = '1h'`, overridable with `JWT_EXPIRES_IN`).

The reason is that a JWT is *self-contained* — that is its great advantage and its great weakness. The server verifies it with arithmetic alone, needing no session store, which is what makes it cheap. But it also means the server has no list of issued tokens and therefore **cannot revoke one**. A stolen token is valid until it expires, full stop.

Expiry is the only lever available, and it is a genuine trade-off: short lifetimes limit the damage of a stolen token but force users to log in more often. One hour is a middle setting for a learning project. Production systems soften the trade-off with *refresh tokens* — a short-lived access token plus a long-lived, revocable refresh token — which is explicitly out of scope for this phase.

It is worth being honest about the remaining limitations rather than pretending a JWT is a complete auth system:

- **No revocation.** Logging out cannot invalidate a token server-side; a client can only forget it.
- **No refresh tokens.** When the hour is up, the user logs in again.
- **Token theft is game over** for that hour. This is why HTTPS is non-negotiable in production and why the payload contains nothing sensitive.

One mitigation *is* implemented: the middleware reloads the user from the database on every request rather than trusting the token's contents. So a deleted account stops working immediately, even with a token that has not expired yet.

---

## 6. Request journey

Three walkthroughs, following a request through the layers.

### Register — `POST /api/auth/register`

```
Request  { name: "Ada Lovelace", email: "Ada@Example.com", password: "correct-horse" }
   │
   ▼
express.json()                 parses the body (malformed JSON → 400 here)
   │
   ▼
validateRegister               name 3-100? email shaped like one? password 8-72?
   │                           unknown fields (passwordHash, _id) → 400
   ▼
authController.register
   │
   ▼
authService.register           normalise email → "ada@example.com"
   │                           already taken? → 409
   │                           bcrypt.hash(password, 12)     ← ~200ms, deliberately
   │                           build { name, email, passwordHash }   ← no `password` field exists
   ▼
userRepository.create → Mongoose → MongoDB
   │
   ▼
toPublicUser()                 allow-list: id, name, email, createdAt, updatedAt
   │
   ▼
201  { success: true, data: { id, name, email, createdAt, updatedAt } }
```

The plaintext password exists only as a function argument, for the few milliseconds before `bcrypt.hash` consumes it. It is never assigned to a document, never logged, never returned.

### Login — `POST /api/auth/login`

```
Request  { email: "ada@example.com", password: "correct-horse" }
   │
   ▼
validateLogin                  both present and non-empty — and nothing more
   │                           (no length rule, no format rule — see below)
   ▼
authService.login
   │
   ├─ userRepository.findByEmailWithPasswordHash()   ← the ONE place that reads a hash
   │
   ├─ no such user? → run a dummy bcrypt.compare anyway, then 401
   │                  (so "unknown email" takes as long as "wrong password")
   │
   ├─ bcrypt.compare(submitted, storedHash)  → false? → 401, same message
   │
   ▼
signToken(user._id)            { sub: "<id>" }, signed, expires in 1h
   │
   ▼
200  { success: true, data: { token: "eyJ...", user: { id, name, email, ... } } }
```

Note what login deliberately does *not* validate: password length and email format. Enforcing the registration password rule here would tell an anonymous caller what the password policy is, and would lock out any account created under an older rule. Whether the credentials are correct is bcrypt's decision, not the validator's.

### Authenticated task creation — `POST /api/tasks`

```
Request  Authorization: Bearer eyJ...      body { title: "Write the docs" }
   │
   ▼
requireAuth                    extract Bearer token → verify signature & expiry
   │                           → look the user up (deleted account → 401)
   │                           → req.user = { id, name, email }   ← a plain object, no hash
   ▼
validateCreateTask             title/description/priority/status rules
   │                           `owner` present in the body? → 400
   ▼
taskController.createTask      taskService.createTask(req.body, req.user.id)
   │                                                            └── from the verified token,
   ▼                                                                never from the body
taskService.createTask         reconcile completed/status (the Phase 3 invariant)
   │                           { ...resolvedData, owner: ownerId }   ← owner written LAST
   ▼
taskRepository.create → MongoDB
   │
   ▼
201  { success: true, data: { ...task, owner: "<the caller's id>" } }
```

The middleware order — **auth, then validation, then controller** — is deliberate. An anonymous request with a malformed body gets `401`, not `400`: someone who has not proven they may use the endpoint should not be learning its field rules.

---

## 7. The ownership model

A task now belongs to a user:

```js
owner: {
  type: mongoose.Schema.Types.ObjectId,
  ref: 'User',
  required: [true, 'Owner is required'],
  index: true,
}
```

`required` matters. It makes "a task with no owner" impossible at the schema level, rather than a convention the service layer has to remember. `index` matters because ownership is now part of *every* task query, making it the most-used filter in the application.

### Ownership is imposed, not requested

The client never supplies `owner`. Three independent layers enforce that:

1. **The validator** rejects a body containing `owner` with a `400`. This is new in Phase 5 and genuinely necessary: before, `owner` was not a schema field, so Mongoose silently discarded it. Now it *is* a schema field, so Mongoose would happily persist whatever a client sent.
2. **The service** writes `owner` last — `{ ...resolvedData, owner: ownerId }` — so even a value that somehow reached it is overwritten by the authenticated user's id.
3. **The repository** takes `ownerId` as an explicit named parameter and applies it after any caller-supplied filter, so ownership cannot be overridden by a crafted filter object.

### Scoping reads, and why 404 rather than 403

Every repository function is scoped:

```js
async function findById(id, ownerId) {
  return Task.findOne({ _id: id, owner: ownerId });
}
```

This is the important design decision of the whole phase. The check is not "fetch the task, then compare its owner to the caller" — it is *"fetch a task belonging to this caller"*. The distinction matters for two reasons:

- There is no window between reading and checking in which the wrong document could be acted upon.
- Another user's task and a task that never existed produce the **identical** result: `null`. The service turns that into a `404` without ever knowing which case it was.

That is why cross-user access returns `404 Not Found` rather than `403 Forbidden`, even though `403` is technically the more accurate word. A `403` would confirm *"this id exists — it is simply not yours"*, which leaks the existence of other users' records. An attacker enumerating ids could map out how much activity other users have, when records were created, and whether a specific id is real. Answering `404` gives them nothing: every id that is not theirs looks exactly like an id that was never issued.

`tests/integration/task.ownership.test.js` asserts this directly, comparing a request for another user's task against a request for a genuinely nonexistent id and requiring the status *and body* to match.

### What ownership does not change

Phase 3's behaviour is untouched. Filtering, search, sorting, pagination and the `completed`/`status` invariant all work exactly as before — they simply operate within one user's tasks instead of the whole collection. `totalCount` counts the caller's matching tasks; page 2 is page 2 of *their* results.

---

## 8. Auth middleware deep dive

`src/middleware/auth.middleware.js` is the gate every protected route passes through. It does five things in order, and each step's failure mode is deliberate.

**1. Extract the token.**
```js
const [scheme, ...rest] = headerValue.trim().split(/\s+/);
if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
```
Splitting on whitespace rather than slicing a fixed offset means `Bearer   <token>` and odd casing behave predictably instead of silently yielding a token with a leading space.

**2. Verify the signature and expiry.** This is where a forged, edited or expired token dies. Crucially, only *jsonwebtoken's own* error types are treated as authentication failures:

```js
const TOKEN_ERROR_NAMES = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);
```

Anything else — a missing `JWT_SECRET`, a database outage — is re-thrown and becomes a `500`. This distinction is not pedantry. If a broken deployment reported `401` to everyone, it would look exactly like "all our users suddenly have bad credentials", and you would spend the outage debugging the wrong system.

**3. Sanity-check the subject** before handing it to Mongoose, so a malformed id becomes a clean `401` rather than a `CastError` and a `500`.

**4. Load the user.** The token proves the id was issued by this server; it does not prove the account still exists. Reloading on every request is what makes a deleted account stop working immediately — the one revocation mechanism available without a session store.

**5. Attach a plain object.**
```js
req.user = { id: user._id.toString(), name: user.name, email: user.email };
```
Not the Mongoose document. There is no path from `req.user` to a password hash even by accident, and no downstream layer can mutate and accidentally save a user document.

Every failure answers `401` with one of two generic messages. An attacker learns "you are not authenticated" and nothing else — not whether the token was absent, malformed, forged, expired, or belonged to a deleted account.

---

## 9. Common security mistakes

A catalogue of the ways this goes wrong, and what this codebase does instead.

**Storing plaintext or encrypted passwords.** Covered in Section 3. Encryption is reversible; that is the whole problem. → `passwordHash`, bcrypt, no reversible form anywhere.

**Using a fast hash (MD5, SHA-256).** Fast is the enemy. → bcrypt at cost 12.

**Hardcoding the JWT secret, or providing a development fallback.** `process.env.JWT_SECRET || 'dev-secret'` is the classic. The fallback silently becomes production's secret the day an env var is forgotten, and it is in your Git history forever. → required, no default, server refuses to boot without it.

**Putting sensitive data in the JWT payload.** It is base64, not encryption. Anyone holding the token reads it. → id only.

**Returning the password hash in API responses.** Usually accidental — `res.json(user)` on a Mongoose document. → three layers: `select: false` on the schema, a `toJSON` transform that deletes the field, and an explicit allow-list in `toPublicUser()`. An allow-list is used rather than `delete user.passwordHash` precisely because a deny-list silently starts leaking whatever field someone adds to the schema next year.

**Different errors for "unknown email" and "wrong password".** Turns login into a free membership-checking oracle: an attacker confirms which addresses have accounts without guessing a single password. → one message, one status, for both.

**Timing leaks.** Even with identical messages, returning early on an unknown email makes that path measurably faster, re-creating the oracle. → a dummy `bcrypt.compare` runs anyway, so both paths cost the same.

**Trusting client-supplied ownership.** `owner: req.body.owner` lets anyone create or reassign records to anyone. → rejected by the validator, overwritten by the service, imposed by the repository.

**Checking ownership after fetching.** `const task = await Task.findById(id); if (task.owner !== user.id)` is fragile — one forgotten check and the data leaks. → scope the query itself; there is nothing to forget.

**Returning 403 for another user's record.** Confirms the record exists. → `404`, identical to a nonexistent id.

**Validating before authenticating.** Leaks the endpoint's field rules to anonymous callers. → `requireAuth` runs first.

**Reporting configuration failures as auth failures.** Hides outages behind a plausible-looking `401`. → only JWT error types become `401`.

---

## 10. How Phase 4's tests protected Phase 5

This is the payoff chapter, and the most honest argument for having written the Phase 4 suite at all.

Phase 5 is invasive. It changed the Task schema, rewrote every function in the task repository, changed the signature of every function in the task service, altered the controller, and put middleware in front of all five routes. Any one of those edits could have broken filtering, pagination, the `completed`/`status` invariant, or the response envelope — regressions that are quiet, easy to miss by hand, and exactly the kind that reach production.

The 321 existing tests made that risk manageable. Concretely, here is what happened while building this phase:

Adding the required `owner` field immediately broke **57 tests**, and the failures were *informative*. The service unit tests failed with `ownerId is required for task operations` — pointing straight at the call sites needing the new argument. The seeding helpers failed because they were creating tasks with no owner. Nothing had to be guessed; the suite named each problem.

The Phase 4 tests also constrained the *design*, not just the correctness. Two examples:

- **Per-route auth instead of `router.use()`.** A Phase 4 test asserts that an unregistered method on a known path (`PUT /api/tasks`) returns `404`. Mounting `requireAuth` with `router.use()` would have made it `401`, because `router.use()` matches every method — silently changing a documented Phase 3/4 contract. The failing test would have caught it; knowing the test existed shaped the decision up front.
- **Unknown fields on create.** Phase 4 pinned the contract that an unrecognised field on `POST /api/tasks` is silently ignored. A blanket field whitelist for `owner` would have broken that. Instead, `owner` is rejected specifically, leaving the established behaviour intact.

The one thing the suite could not do was tell me the *new* behaviour was right. Tests protect what they assert, and nothing asserts what does not exist yet — which is why Phase 5 adds 241 of its own, including adversarial cases (forged signatures, the `alg: none` attack, tampered payloads, cross-user access, owner injection) that only become meaningful once there is something to attack.

The final number worth stating plainly: **all 321 Phase 4 tests still pass, unmodified in their assertions.** The only changes to those files were mechanical — swapping `request(app)` for an authenticated equivalent and passing an owner to the seeders. Not one expectation about filtering, pagination, sorting, validation or error shapes had to be weakened to accommodate authentication. That is the evidence that Phase 5 added a layer rather than disturbing what was underneath.

---

## 11. Checkpoint quiz

1. Why can't HTTP remember who a user is between two requests?
2. What question does authentication answer, and what different question does authorization answer?
3. Which HTTP status means "I don't know who you are", and which means "I know, and no"?
4. Why is storing an *encrypted* password still the wrong answer?
5. Why does a password leak from a small app endanger accounts on other sites?
6. What makes SHA-256 a poor password hash despite being a good hash function?
7. What does bcrypt's cost factor control, and what happens when you increase it by one?
8. What is a salt, and what attack does it defeat?
9. Why do two users with the same password end up with different stored hashes here?
10. Why does this project reject passwords longer than 72 characters instead of accepting them?
11. Is a JWT encrypted? What follows from the answer?
12. What stops an attacker from editing a JWT's payload and using it?
13. Why is there no fallback value for `JWT_SECRET`?
14. Why can't a JWT be revoked, and what does this project do about it?
15. Why does the auth middleware reload the user from the database instead of trusting the token's contents?
16. Why does only a `JsonWebTokenError` become a 401, while other errors become 500s?
17. Name the three independent layers that stop a client choosing a task's owner.
18. Why is `findOne({ _id: id, owner: ownerId })` safer than fetching the task and then comparing owners?
19. Why does this API return 404 instead of 403 when you request someone else's task?
20. Why does `requireAuth` run before the validation middleware?

### Answers

1. HTTP is stateless — each request arrives independently, with no built-in link to any earlier one. Identity must therefore be carried inside every request.
2. Authentication answers "who are you?"; authorization answers "what are you allowed to do?" Authentication must happen first, because you cannot decide permissions for an unknown caller.
3. `401 Unauthorized` is the authentication failure (despite its name) and `403 Forbidden` is the authorization one.
4. Encryption is reversible by design, so a key exists — and a key can be stolen along with the data. Password storage must be *irreversible*, not merely obscured.
5. Because people reuse passwords. A password harvested from a minor app is frequently the same one guarding the user's email, which in turn controls password resets for everything else.
6. It is fast. Password hashing needs slowness: an attacker with a stolen database simply guesses, and SHA-256 lets them guess billions of times per second.
7. It controls how much computational work each hash takes. Each increment doubles it — slowing both legitimate logins (imperceptibly) and offline attacks (enormously).
8. Random data mixed into each hash so identical inputs produce different outputs. It defeats precomputed rainbow tables and prevents identical hashes from revealing that two users share a password.
9. bcrypt generates a fresh random salt per hash and stores it inside the resulting 60-character string.
10. bcrypt only considers the first 72 bytes. Silently ignoring the rest would mean two different long passwords could unlock the same account, so the input is rejected explicitly instead.
11. No — it is signed and base64url-*encoded*, which anyone can decode. It therefore must never carry secrets; its payload here is just the user id.
12. The signature, computed from the payload plus a server-only secret. Any edit invalidates it, and a valid replacement cannot be produced without the secret.
13. Because a fallback silently becomes the real secret whenever the environment variable is forgotten — and it lives in the repository, letting anyone who has read the source forge a token for any user.
14. A JWT is self-contained and verified by arithmetic alone, so the server keeps no list of issued tokens to invalidate. This project limits the exposure with a one-hour expiry and by reloading the user on every request.
15. So that state which changed after the token was issued — most importantly a deleted account — takes effect immediately, rather than remaining valid until the token expires.
16. Because a missing secret or a database outage is a *server* fault. Reporting it as 401 would disguise an outage as every user simultaneously having bad credentials, sending you to debug the wrong system.
17. The validation middleware rejects an `owner` field with 400; the service writes `owner` last from the authenticated id; the repository takes `ownerId` as an explicit parameter and applies it after any caller filter.
18. It removes the gap between reading and checking, and it makes "not yours" indistinguishable from "does not exist" — both return `null`, so there is no comparison step a future edit could forget.
19. Because 403 would confirm that the id exists and simply belongs to someone else, leaking the existence of other users' records to anyone enumerating ids. A 404 makes another user's task look exactly like an id that was never issued.
20. So that an unauthenticated caller receives 401 rather than a 400 that would teach them the endpoint's field rules before they have proven they may use it at all.
