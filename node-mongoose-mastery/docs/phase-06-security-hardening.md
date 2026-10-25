# Phase 6: Security Hardening

Five phases built an API that works. This one asks: **what happens when someone uses it badly on purpose?**

Everything so far assumed a well-behaved client. Phase 6 removes that assumption, adding the layers between a working API and a hostile internet — and is equally careful about what those layers do *not* do.

One promise up front: **nothing here makes the API secure.** It makes it meaningfully harder to abuse. Those are different claims, and the difference is section 11.

---

## 1. Security is a layered system

No single control makes an application safe. There is only a sequence of controls, each catching what the previous one let through:

```
Client
  ↓
CORS / browser policy        does this browser page get to read the response?
  ↓
Rate limiter                 is this client asking too often?
  ↓
Body parser + size limit     is this payload even a sane size and shape?
  ↓
Authentication               who is this?
  ↓
Validation                   is this request well-formed?
  ↓
Authorization                may *this* user touch *this* record?
  ↓
Service rules                does this violate a business invariant?
  ↓
Repository allow-listing     only known fields ever reach a query
  ↓
Mongoose constraints         the schema is the last line
  ↓
MongoDB
```

The value is in the redundancy. If rate limiting is off, brute force gets faster — but every guess still has to survive bcrypt and still returns the same opaque 401. If validation misses a field, the repository only builds queries from allow-listed fields and the schema rejects the rest. And nobody can forget an ownership check, because the repository scopes every query by owner *at the query level* — there is no separate check to omit.

Defence in depth is not paranoia. It is an admission that you will get something wrong, and a decision to make that mistake survivable.

---

## 2. Threat model for this project

Naming what you are defending against keeps a security review concrete.

| Threat | What an attacker does | Control | Residual risk |
|---|---|---|---|
| Brute-force login | Guesses passwords at machine speed | Auth limit (10/15min), bcrypt cost 12, identical error every failure | A weak password can still fall in a few tries |
| Credential stuffing | Replays leaked passwords | Same as above | No breach-password blocklist, no MFA |
| Oversized request | Sends a 500 MB body | 16 KB JSON limit → 413 | Infrastructure floods unaffected |
| Malicious/buggy input | `completed: "yes"`, operator-shaped values | Strict boolean validation, scalar-only params, allow-lists | Only what validators know about |
| Duplicate query values | `?page=1&page=2` | Rejected with 400 | — |
| Token tampering | Edits payload, strips signature, swaps algorithm | Signature check, pinned HS256, strict Bearer parsing | A *stolen* valid token works until expiry |
| Owner spoofing | Sends `owner` to create or steal a task | Validator rejects, service overwrites, repository imposes | — |
| Information leakage | Reads stack traces to map the system | Generic messages, identical 404 for "not yours" | — |
| Vulnerable dependencies | Exploits a known CVE | `npm audit` review, lockfile, targeted patches | Only *known* advisories |
| Cross-origin browser calls | Malicious page calls API from a user's browser | Explicit CORS allow-list | Nothing outside a browser is constrained |

**Explicitly out of scope:** TLS, DDoS protection, WAF, secret management, token revocation, monitoring, database encryption, backups, and penetration testing. Section 11 covers why.

---

## 3. Helmet and HTTP headers

Helmet sets response headers that instruct *browsers* to behave more defensively. It is mounted **first** — before CORS, the limiter and the router — because every response must carry these headers, including ones that never reach a route: a 429 from the limiter, a 404, a 500. The suite asserts that across all six status codes.

The headers that matter for a JSON API:

- **`X-Content-Type-Options: nosniff`** — the single most relevant one here. Without it, a browser may ignore your `Content-Type` and guess based on content, which is how a JSON response gets executed as script. `nosniff` says: believe the declared type or refuse.
- **`X-Frame-Options: SAMEORIGIN`** — clickjacking protection. Largely moot for an API returning no HTML, but free.
- **`Referrer-Policy: no-referrer`** — stops URLs (which often contain resource ids) leaking via the `Referer` header.
- **`X-Powered-By` removed** — Express advertises itself by default. Not a real defence, since servers are fingerprintable other ways, but there is no reason to hand a scanner a free hint. The project also calls `app.disable('x-powered-by')` explicitly, so the guarantee survives a Helmet config change.
- **`Content-Security-Policy`** — governs what a *document* may load. Close to inert for a pure JSON API; kept because it costs nothing.
- **`Strict-Transport-Security`** — worth being precise about, because it is widely misunderstood. HSTS tells a browser *"never use plain HTTP for this host again."* It does nothing on its own: it cannot upgrade a connection, and a browser receiving it over plain HTTP ignores it entirely. **It only protects users once HTTPS is actually deployed.** Shipping the header over HTTP is not a security control; it is a note to your future self.

The thing to internalise: **headers are instructions to a browser.** They have no opinion whatsoever about a malformed request body, a forged token or a cross-tenant read. A request from `curl` ignores every one of them. Helmet and input validation protect different things, and neither substitutes for the other.

---

## 4. CORS without myths

CORS is the most misunderstood control in web security, so precision matters.

An **origin** is the triple `scheme://host:port`. `https://app.test` and `http://app.test` differ; so do `:443` and `:8443`.

The **same-origin policy** is a browser rule: JavaScript on origin A may *send* a request to origin B, but may not *read* the response unless B explicitly permits it. CORS is how B grants that permission, via an `Access-Control-Allow-Origin` header.

For anything other than a simple request, the browser first sends a **preflight** `OPTIONS` asking "may I send a PATCH with an Authorization header?" The server answers with the permitted methods and headers. This project answers preflight with `204` and advertises `GET, POST, PATCH, DELETE, OPTIONS` plus `Content-Type, Authorization`.

Three decisions worth explaining:

**The allow-list is explicit, with no wildcard default.** `ALLOWED_ORIGINS` is a comma-separated list, trimmed, with empty entries dropped so a trailing comma is harmless. If unset, *no browser origin is permitted* — the failure mode is "deny", never "allow everything".

**A disallowed origin gets no header, not an error.** The origin callback returns `false` rather than throwing. Throwing would reach the error handler and turn a routine client-side policy decision into a `500`. Inventing a bespoke `403` would be worse: it would let an attacker map the allow-list by comparing status codes. Omitting the header is the standard CORS rejection, and every disallowed origin looks identical.

**Requests with no `Origin` header are allowed.** This is a deliberate, documented policy. `curl`, Postman, Supertest, mobile apps and server-to-server callers send no `Origin`. Blocking them would break every non-browser client while adding no security at all — anything that can omit the header can equally forge one. The gate for those callers is the JWT.

Which leads to the three myths worth killing:

1. **CORS is not authentication.** It answers "may this page read this response", never "who are you".
2. **CORS does not stop curl.** It is enforced *by the browser*, on the client side. A non-browser client simply ignores it. The test suite proves this: a request with a disallowed `Origin` and a valid token still returns `200`, because Supertest is not a browser.
3. **CORS does not replace authorization.** Ownership checks still run on every request.

Credentials mode is off (`credentials: false`), and that is not an oversight — it exists for cookies and HTTP auth. This API authenticates with a bearer token the client sets explicitly, so enabling it would grant browsers a capability the architecture does not use.

---

## 5. Rate limiting

Two limiters, because two different things are being defended.

**The general limiter** covers all of `/api`: 300 requests per 15 minutes, targeting scraping, runaway retry loops and cheap denial-of-service attempts.

**The authentication limiter** is far stricter — 10 per 15 minutes — and covers only `/api/auth/login` and `/api/auth/register`. A human logs in once or twice; a credential-stuffing script tries thousands of passwords.

Both return `429` with the same envelope as every other error in the API:

```json
{ "success": false, "message": "Too many requests. Please try again later." }
```

A client parsing `success` and `message` needs no special case for being throttled. The body deliberately discloses no counters or configuration — the standard `RateLimit` headers already tell a well-behaved client what it needs, and the body telling an abuser the exact ceiling just tells them how to stay under it.

**The counting policies differ on purpose**, and the reasoning is worth following:

- **Login counts only failures.** Brute force is, by definition, a stream of failed attempts, so failures are what consume the allowance. A legitimate user who signs in correctly never exhausts their own budget and never locks themselves out.
- **Registration counts everything.** Here the *successful* request is the abuse — automated mass account creation — so skipping successes would defeat the point.

Two honest limitations:

**The store is in-memory.** Correct for a single-process project, wrong for a scaled one: with N instances each keeping its own counters, the effective limit becomes N × limit, and a restart resets everything. A proper fix needs a shared store (Redis), deliberately out of scope.

**Rate limiting does not make weak passwords safe.** It turns "thousands of guesses per second" into "a handful per window" — an overnight attack becomes infeasible. But an attacker who guesses right on the third attempt was never rate-limited. Rate limiting buys time; password strength and bcrypt's cost are what make guessing expensive.

---

## 6. Request size and input shapes

**`400` versus `413`** are different client mistakes. Malformed JSON is `400` ("I could not parse this"); an oversized body is `413` ("I refused to read this"). Collapsing them leaves a caller guessing. The limit is 16 KB: a task's 100-character title and 1000-character description put a legitimate request well under 2 KB, so 16 KB is generous headroom while refusing a multi-megabyte payload outright.

The limit is parsed into a byte count at startup, so a typo fails loudly rather than silently becoming "unlimited". Body-size limits stop trivially cheap memory exhaustion; they do nothing about a distributed flood, which is an infrastructure problem.

### Strict boolean validation, and why Mongoose must not define the contract

The most instructive fix in this phase. Before Phase 6, `POST /api/tasks` did not check `completed` at all, relying on Mongoose's Boolean cast — far more permissive than any sane public contract:

| Sent | Stored (before) | Now |
|---|---|---|
| `"yes"` | `true` | `400` |
| `"no"` | `false` | `400` |
| `1` / `0` | `true` / `false` | `400` |
| `null` | **`null`** | `400` |
| `true` / `false` | `true` / `false` | unchanged |

That `null` row was a genuine defect. A task with `completed: null` and `status: "todo"` **violates the completed/status invariant** the whole API is built around, since `todo` implies `completed === false`. The audit found it by probing, not by reading. Worse, `POST` and `PATCH` disagreed — update rejected `"yes"`, create accepted it — and a contract that depends on which verb you used is a bug by definition.

The principle generalises: **a database driver's casting rules are an implementation detail.** If they define what your API accepts, your contract silently changes the day the driver's coercion table does. Both endpoints now share one `validateCompleted` helper.

### Duplicate query parameters

Express's query parser turns `?page=1&page=2` into `['1','2']` and `?search[$ne]=x` into `{ $ne: 'x' }`. Both are ambiguous, and the audit found three ways this leaked through:

- `?search=a&search=b` — silently *ignored* (an array is not a string, so the search was dropped)
- `?search[$ne]=x` — silently ignored, same reason
- `?page[0]=1` — silently **accepted as page 1**, because `Number(['1'])` is `1`

The policy is now: **every recognised parameter must arrive exactly once, as a scalar, or the request is rejected with 400.** Rejection beats silently picking the first or last value, because silently choosing hides a genuine client bug and makes two different requests behave identically for no stated reason.

It is also shape-safe. An object-shaped value is how a NoSQL operator gets smuggled through a query string; refusing the shape means that defence no longer depends on every future filter being written carefully. Only *recognised* parameters are policed, so a caller appending their own tracking parameter is unaffected.

### On prototype pollution: test, don't assume

It would be easy to claim Express is vulnerable to `?__proto__[polluted]=yes`. The audit tested it instead: `qs` drops `__proto__` keys entirely, `JSON.parse` creates a plain own property rather than invoking the prototype setter, and `Object.prototype` is never modified. Regression tests assert this so a future dependency change cannot quietly break it — but no vulnerability is claimed, because none was demonstrated.

This is why no generic sanitiser package was added. The real protection is allow-listing: only known fields reach a query, and values are compared against fixed sets. A sanitiser that blindly mutates request objects would add a dependency, obscure the data flow, and substitute for the design already doing the work.

---

## 7. JWT hardening

Phase 5 built the JWT flow. Phase 6 tightens four things.

**Secret strength.** `JWT_SECRET` was already mandatory with no fallback; it now has a 32-character minimum. Not a cryptographic law — a floor ruling out the secrets people actually choose under deadline pressure (`secret`, `dev`, the project name). HS256 derives its key from those bytes, so a short guessable secret means forgeable tokens for every user. The error names the requirement and the length supplied, **never the value**.

**Explicit algorithm.** A JWT carries its own `alg` header, and a naive verifier trusts it. That is the root of two classic attacks: `alg: none` (claim the token needs no signature) and RS256→HS256 confusion (hand a verifier expecting a public key an HMAC signed *with* that public key). Both are closed by passing an explicit allow-list:

```js
jwt.verify(token, getSecret(), { algorithms: ['HS256'] });
```

The token's own header can no longer influence how it is checked.

**Strict Bearer parsing.** The header must be exactly `Bearer <token>`. This matters because duplicate `Authorization` headers are joined by the HTTP layer into `"Bearer AAA, Bearer BBB"`. The old parser stitched that into one nonsense token and let `jwt.verify` reject it — *by accident*, as a signature failure, rather than because the request was structurally invalid. Refusing the shape makes the rejection deliberate.

**Minimal payload and explicit expiry** are unchanged from Phase 5: `sub`, `iat`, `exp`, and nothing else, expiring in one hour.

The limitation worth repeating: a JWT is **stateless and self-contained**. The server keeps no list of issued tokens, which is what makes verification cheap — and also means **it cannot revoke one**. A stolen token is valid until it expires. Expiry is the only lever, and the one mitigation in place is that the middleware reloads the user on every request, so a *deleted* account stops working immediately. Refresh tokens and a revocation list are out of scope for this phase.

---

## 8. Middleware order

Order is a security decision, not a style choice.

```
app.disable('x-powered-by')
  ↓
helmet()                       headers on EVERY response, including errors
  ↓
cors()                         preflight answered here, never reaches the router
  ↓
rateLimit('/api')              reject before spending memory on parsing
  ↓
express.json({ limit })        bounded parsing; 413 / 400 decided here
  ↓
/api/auth  →  [strict limiter] → validate → controller
/api/tasks →  requireAuth → validate → controller → service → repository
  ↓
notFoundHandler
  ↓
errorHandler                   one safe exit for everything
```

Each position earns itself:

- **Helmet first**, so a 429 or a 500 still carries security headers.
- **Rate limiting before body parsing**, so a throttled request is rejected before the server spends memory parsing a payload it will discard.
- **Auth before validation** on protected routes, so an anonymous caller gets `401`, not a `400` that would teach them the endpoint's field rules before they have proven they may use it.

**A successful request:** `POST /api/tasks` with a valid token and `{"title":"Buy milk"}`. Helmet sets headers; CORS sees no `Origin` (curl) and allows it; the limiter counts one; the parser accepts 30 bytes; `requireAuth` verifies HS256 and sets `req.user`; `validateCreateTask` checks the title and confirms no `owner` was sent; the service writes `owner` last from the verified identity. `201`.

**A rejected request:** the same call with `{"title":"Buy milk","completed":"yes","owner":"<someone else>"}`. Identical path until validation, which accumulates two errors — `completed` is not a boolean, `owner` may not be client-supplied — and answers `400` with both. Nothing reaches the service, nothing is written, and the response still carries every security header.

One ordering subtlety worth knowing: `express.json()` is app-level, so it runs *before* the router and therefore before `requireAuth`. Malformed JSON on a protected route returns `400`, not `401`. That is the observed behaviour, tested and documented rather than assumed.

---

## 9. Security testing

Phase 4's suite is what made Phase 6 safe to attempt. Adding Helmet, CORS, two limiters, a body limit, strict validation and a query-shape policy touches every request in the application. Without 571 existing tests, "did I break the API while securing it?" would have been unanswerable.

Concretely: when the strict boolean rule landed, exactly one existing test failed — the one that *documented the old defective behaviour* (`completed: "yes"` → 201). That is the suite working perfectly: it pointed at the single assertion encoding the contract being deliberately altered, which was then updated with a comment explaining the before and after. Twelve other failures were JWT fixtures whose secrets were now too short — also correct, since the policy genuinely changed.

Security tests lean on **boundaries and negative cases**, because security bugs live at the edges:

- Exactly at the limit vs. one past it (rate limit, body size, secret length).
- Every wrong type for one field, not just the obvious one (`"yes"`, `1`, `null`, `[]`, `{}`).
- Every ambiguous shape for every recognised parameter.
- Every distinct way a token can be wrong, asserting they all look *identical* to the caller.

Two techniques are worth stealing. **Test indistinguishability, not just rejection**: a cross-user read must return the *byte-identical* response to a nonexistent id, or the status code becomes an oracle. **Make the underlying error hostile**: the 500 tests throw errors containing a fake connection string and a fake bcrypt hash, proving the handler's output does not depend on how careless the thrown error is.

Coverage exposed two bugs in this phase's *own* new code: an unreachable guard in the Bearer parser (removed) and a comma check a test missed by a single space. That is coverage used properly — a tool for finding untested paths, not a score.

And the caveat: **a test suite cannot prove the absence of vulnerabilities.** These tests prove the threats we *thought of* are handled as *intended*. They say nothing about an attack nobody modelled. Passing tests are evidence, not a certificate.

---

## 10. Dependency security

Three packages were added: `helmet` (headers), `cors` (policy), `express-rate-limit` (limiting). Each solves one problem, none overlap, all actively maintained with compatible engines.

`npm audit` initially reported **2 moderate vulnerabilities**, both in `qs` — reachable through `express@4.22.2`, which used the vulnerable `qs@6.15.3` to parse every query string. Since this project parses query strings on its busiest endpoint, the finding was genuinely reachable, not theoretical.

The fix was a **targeted patch upgrade**: `express@4.22.3` depends on `qs@~6.16.0`, resolving both advisories, and sits inside the already-declared `^4.19.2` range. `npm audit` now reports **0 vulnerabilities**.

Four ideas this illustrates:

**A finding is not an exploit.** A scanner reports that a version matches an advisory; whether the vulnerable *code path* is reachable is a separate question you must answer. Here it was, which raised the priority. Often it is not — a build-time dev dependency with a CVE in a path you never call is a different risk from a request-path one. Report both; treat them differently.

**Direct versus transitive matters.** `qs` is not in `package.json`; it arrived through Express. You usually cannot upgrade it directly — you upgrade the parent that pins it.

**`npm audit fix --force` is not a fix, it is a gamble.** The `--force` flag installs semver-major upgrades to satisfy the scanner, which can silently replace Express 4 with Express 5 and break your application to make a number go to zero. This project never used it. The rule: prefer the smallest change that resolves the advisory, and verify with tests afterwards — which is exactly what happened here (910 tests re-run, all passing).

**Lockfiles matter.** `package.json` records a *range*; `package-lock.json` records exactly what was installed. Without it, "works on my machine" and "works in production" are different dependency trees — and the lockfile is what makes an audit meaningful, since it audits what you actually ship.

Finally: **zero vulnerabilities is not a certificate.** It means no *published advisory* matches your installed versions today — nothing about unpublished vulnerabilities, your own code, or an advisory filed tomorrow.

---

## 11. What this phase does not solve

Being specific here is the difference between a security posture and security theatre.

- **TLS termination.** This API speaks plain HTTP. Tokens, passwords and task data travel in clear text unless something in front terminates HTTPS. `Strict-Transport-Security` is set but inert until that is true. **The single largest gap.**
- **Firewalls and WAF.** No protection against volumetric attacks or traffic that never reaches Node.
- **Distributed rate limiting.** In-memory counters neither survive a restart nor coordinate across instances.
- **Secret management.** `JWT_SECRET` lives in a `.env` file: no vault, no rotation, no audit trail.
- **Token revocation.** No way to invalidate a stolen token before it expires; no refresh tokens.
- **Monitoring and alerting.** Nobody is told when the auth limiter fires repeatedly — which is what an attack looks like. Errors go to `console.error` and nowhere else.
- **Container, host and database security.** No image scanning, least-privilege runtime, OS hardening, encryption at rest, or network isolation.
- **Backups and recovery.** None. A dropped collection is gone.
- **Penetration testing.** Nobody hostile and skilled has tried to break this.

**The API is improved, not certified.** It is harder to abuse than it was at the end of Phase 5. It has not been assessed against any standard, and no compliance claim is being made.

---

## 12. Incident walkthroughs

**Login brute-force.** An attacker POSTs to `/api/auth/login` with one email and a password list. Requests 1–10 each take ~200ms (bcrypt, by design) and return an identical `401` — the same response an unknown email produces. Request 11 returns `429`, capping them at 10 guesses per 15 minutes. *What still gets through:* if the password is in the first ten guesses, none of this helps.

**Oversized JSON.** A client POSTs a 5 MB body. The limiter counts it, then `express.json` stops reading at 16 KB and raises `entity.too.large`. The handler answers `413`, disclosing neither the body nor the configured limit. Nothing reaches validation, the service, or the database.

**Disallowed browser origin.** A page on `https://evil.test` calls the API with a stolen token. The request *is* served — a valid bearer token is a valid bearer token — but the response carries no `Access-Control-Allow-Origin`, so the browser refuses to expose it to the attacking page. *The honest caveat:* this protects the user's browser, not the API. The same request from `curl` reads the response fine.

**Tampered JWT.** An attacker decodes their token, changes `sub` to another user's id, re-encodes, and keeps the original signature. `jwt.verify` recomputes the signature over the modified payload, mismatches, and throws `JsonWebTokenError`. The middleware returns `401` with the same generic message as an expired or malformed token. Swapping the header to `alg: none` fails too, because the allow-list ignores what the token claims.

**Duplicate pagination parameter.** A buggy client sends `?page=1&page=2`; Express produces `['1','2']` and the shape check rejects it with `400`. Previously `Number(['1','2'])` was `NaN` so this already failed — but `?page[0]=1` did *not*, being silently accepted as page 1. Both are now rejected identically, so the client learns about its bug instead of getting quietly plausible results.

**Owner spoof.** An attacker POSTs `{"title":"Not mine","owner":"<victim id>"}`. Three layers independently prevent it: the validator rejects it with `400`; the service writes `owner` last from `req.user.id`, overwriting anything supplied; and the repository scopes every query by owner. They cannot create a task for someone else, nor read one.

---

## 13. Checkpoint quiz

1. Why does defence in depth matter if each individual layer already works?
2. Helmet is mounted before the rate limiter. What breaks if you swap them?
3. Why does `Strict-Transport-Security` do nothing for an API served over plain HTTP?
4. A reviewer says "we have Helmet, so input validation is less important." What is wrong with that?
5. What exactly is an "origin", and why are `http://app.test` and `https://app.test` different?
6. Why does `curl` ignore your CORS policy, and what actually stops an unauthorised `curl` request?
7. Why does a disallowed origin get *no header* rather than a `403`?
8. Why are requests with no `Origin` header allowed, and why is that not a hole?
9. Why is the login limiter stricter than the general one?
10. Why do failed logins count against the limit while successful ones do not — and why is registration the opposite?
11. Why does an in-memory rate-limit store break when you run three instances?
12. Rate limiting is in place. Is a six-character password now safe? Why not?
13. What is the difference between a `400` and a `413`, and why keep them distinct?
14. Why should Mongoose's Boolean casting not define which values the API accepts?
15. Why was `completed: null` a real defect rather than a cosmetic one?
16. Why reject `?page=1&page=2` instead of just using the first value?
17. Why does `?search[$ne]=x` deserve rejection even though it never reached MongoDB?
18. What are the two attacks that pinning `algorithms: ['HS256']` prevents?
19. Why can a stolen JWT not be revoked here, and what limits the damage?
20. `npm audit` reports zero vulnerabilities. What have you actually proven?

### Answers

1. Because you will eventually get one layer wrong. Redundancy makes a single mistake survivable rather than fatal.
2. A request rejected by the limiter would never pass through Helmet, so `429` responses would ship without security headers.
3. HSTS is an instruction to browsers to avoid plain HTTP in future. It cannot upgrade a connection itself, and browsers ignore it when it arrives over HTTP — so it only takes effect once HTTPS is genuinely deployed.
4. Headers instruct a *browser*. They have no effect on a malformed body, a forged token, or a non-browser client. The two controls protect different things.
5. The triple `scheme://host:port`. Different schemes mean different origins because an attacker on plain HTTP could otherwise impersonate the secure site.
6. CORS is enforced by the browser, client-side; `curl` simply does not implement it. What stops an unauthorised request is the bearer token checked by `requireAuth`.
7. Throwing would produce a `500` for a routine policy decision, and a distinct `403` would let an attacker map the allow-list by comparing responses. Omitting the header makes every disallowed origin look identical.
8. Because every non-browser client (curl, Postman, server-to-server, the test suite) sends no `Origin`, and anything that can omit the header can equally forge one — so blocking them costs compatibility and buys no security. Authentication, not CORS, is their gate.
9. Because the threat profile differs: a human logs in once or twice, while a credential-stuffing script tries thousands of passwords. The endpoint where guessing is the attack needs a much tighter ceiling.
10. Brute force is a stream of *failures*, so counting failures throttles the attack without ever locking out a user who logs in correctly. Registration is inverted because the *successful* request — mass account creation — is itself the abuse.
11. Each instance keeps its own counters, so the effective limit becomes N × limit, and any restart wipes the state. Coordinating requires a shared store.
12. No. Rate limiting slows guessing; it does not help if the correct password is among the first few attempts. Password strength and bcrypt's cost are what make guessing expensive.
13. `400` means "I could not parse this"; `413` means "I refused to read this." Merging them would leave the caller unable to tell a syntax bug from a size problem.
14. Because a driver's coercion rules are an implementation detail. If they define the contract, the contract silently changes whenever the driver's coercion table does.
15. Because `completed: null` with `status: "todo"` violates the completed/status invariant, which requires `todo` to imply `completed === false`. It corrupted data rather than merely being untidy.
16. Silently choosing one value hides a genuine client bug and makes two different requests behave identically for no stated reason. Rejecting tells the client something is wrong.
17. Refusing the *shape* means the defence no longer depends on every present and future filter being written carefully. Relying on downstream code to handle an operator-shaped value is one refactor away from failing.
18. `alg: none`, where a token claims it needs no signature; and RS256→HS256 confusion, where a verifier expecting a public key is handed an HMAC signed with that public key.
19. Because a JWT is stateless and self-contained — the server keeps no list of issued tokens, which is what makes verification cheap. Damage is limited by the one-hour expiry and by reloading the user on every request, so a deleted account stops working immediately.
20. Only that no *published advisory* matches your installed versions today. It says nothing about unpublished vulnerabilities, your own application code, or an advisory filed tomorrow.
