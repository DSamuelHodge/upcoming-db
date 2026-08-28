# Architecture & Production-Readiness Analysis — `upcoming-db`

**Author perspective:** Principal Architect / Staff Engineer
**Scope:** Scheduling + booking data layer on LibSQL/Turso (availability engine, multi-host routing, atomic booking write).
**Method:** Static review of all source, schema, and tests in the repo as of the initial commit. Every finding cites a file:line.
**Severity:** 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low

---

## 0. Executive summary

The domain core is genuinely well-built: `availability-engine.ts` is pure and DST-correct,
input is validated with Zod, bookings are idempotent, and buffers are snapshotted at write
time. Those are the right instincts and should be preserved.

The risks are concentrated in **(a) schema single-sourcing**, **(b) the unverified
transaction/concurrency contract**, and **(c) configuration and secret handling leaking into
source**. None are architectural dead-ends; all are fixable incrementally. Top three to do
first:

1. 🔴 Eliminate the hand-maintained third schema copy (`test-db.ts`) — it already diverges
   from production and will keep doing so silently.
2. 🔴 Write one concurrency test that proves the booking transaction is atomic under
   contention (the current safety argument rests on an assumption about `drizzle-libsql` that
   the repo itself flags as suspect).
3. 🟠 Remove the ad-hoc `.env` file reader in `daily.ts` and stop hardcoding address/phone
   defaults in `notifications.ts`.

---

## 1. Strengths (keep these)

- **Pure, swappable domain core.** `availability-engine.ts` depends only on the
  `AvailabilityRepository` interface (`availability-engine.ts:49`), never on Drizzle/SQL. This
  is the single best decision in the codebase and is what makes the engine testable with an
  in-memory fake and reusable across data layers.
- **DST correctness done the hard, correct way.** The engine walks day-by-day in the
  schedule's *local* timezone and lets Luxon resolve the offset per date
  (`availability-engine.ts:112-128`). `exactWallClock` even handles the spring-forward gap
  (nonexistent wall clock) and fall-back fold (`availability-engine.ts:214-246`). This is
  rare and correct; guard it with tests (see §6).
- **Idempotency.** Client-supplied `idempotencyKey` is a unique column
  (`schema.ts:120`); retry/replay is handled in `createBookingHandler`
  (`create-booking-handler.ts:285-320, 348-351`). Correct foundation for at-least-once callers.
- **Buffer snapshotting.** `bufferBefore`/`bufferAfter` are denormalized onto the booking row
  at insert (`create-booking-handler.ts:446-447`, `schema.ts:112-116`). Prevents a later
  event-type edit from silently rewriting a past booking's conflict footprint.
- **Uniform host model.** Every event type — including `individual` — has rows in
  `event_type_hosts` (`event-types.ts:19-42`), removing `scheduling_type`-based branching.
- **Input validated at the boundary.** `CreateBookingInput` is Zod-parsed
  (`create-booking-handler.ts:25-40`).
- **Preview/commit split for round-robin.** The host chosen at query time is explicitly a
  preview and is re-verified inside the transaction (`multi-host-routing.ts:116-173`,
  `create-booking-handler.ts:408-427`). This is the correct pattern.

---

## 2. 🔴 Schema is defined in three places and they already diverge

There are **three** independent schema definitions that must be kept in sync by hand:

- `schema.ts` (Drizzle, used by app + tests)
- `schema.sql` (applied to live instances via `apply-schema.ts`)
- the `DDL` array in `test-db.ts` (used by handler tests)

A diff of the index definitions shows `test-db.ts` is **missing six objects that exist in
production**:

| Object | `schema.sql` | `test-db.ts` |
|---|---|---|
| `availability_schedule_idx` | ✅ (line 28) | ❌ absent |
| `event_type_owner_slug_unique` | ✅ (line 42) | ❌ absent |
| `event_type_hosts_event_type_idx` | ✅ (line 51) | ❌ absent |
| `bookings_host_time_idx` | ✅ (line 66) | ❌ absent |
| `host_occupancy_ticks_booking_idx` | ✅ (line 75) | ❌ absent |
| `booking_host_unique` | ✅ (line 82) | ❌ absent |
| `credentials` table | ✅ (line 97) | ❌ absent |

**Why this matters:** handler tests execute against a structurally weaker schema than
production. A query plan, a unique-constraint behavior, or a FK interaction that passes in CI
can behave differently (or wrong) in prod, and vice-versa. The `event_type_owner_slug_unique`
gap in particular means a test can insert duplicate `(owner, slug)` pairs that production
forbids. This is the highest-leverage maintenance hazard in the repo.

**Recommendation (do this first):**
- Single-source the schema. The lowest-friction path: generate `schema.sql` from
  `schema.ts` (`drizzle-kit generate`/`push`) and have tests boot their SQLite file from that
  same `schema.sql` (or from `drizzle-kit push` against `file:`). Delete the hand-written
  `DDL` array in `test-db.ts`.
- If a short-term fix is needed, at minimum align `test-db.ts` to `schema.sql` *now* and add a
  CI step that diffs the two (or asserts the live instance's `sqlite_master` matches the
  Drizzle introspection).
- Track the drift in `AGENTS.md`'s "Schema lives in three places" note as a known liability,
  not a feature.

---

## 3. 🔴 The concurrency/atomicity contract is asserted but not proven

The design's safety rests on two mechanisms, both of which deserve a hard test rather than
trust:

1. The booking runs inside `db.transaction(...)` (`create-booking-handler.ts:369`).
2. A concurrent loser is caught by the `host_occupancy_tick_unique` index
   (`schema.ts:145`) when its tick insert collides, surfacing as `SlotConflictError`
   (`create-booking-handler.ts:233-235, 353-355`).

But `AGENTS.md` itself states *"drizzle-libsql ignores BEGIN IMMEDIATE"*, and the code adds a
`host_mutexes` upsert that *looks* like a lock but isn't one:

- `acquireHostMutex` does `INSERT … ON CONFLICT DO UPDATE SET hostUserId = hostUserId`
  (`create-booking-handler.ts:238-246`). An upsert takes a write lock only for the instant of
  the statement; it does **not** hold a lock until commit. Two transactions can both upsert
  the same mutex row and proceed. So `host_mutexes` provides **no serialization** — it is
  effectively dead weight. The only things that actually serialize writers are (a) SQLite's
  single-writer commit lock and (b) the tick-unique index failing the loser.
- The retry loop keys off `SQLITE_BUSY` (`create-booking-handler.ts:322-344`), which implies
  the libsql client *does* serialize writes at the instance — good for a single instance, but
  the explanation in the code ("`host_mutexes` serializes writers") is misleading.

**The real risk:** if `db.transaction` does **not** actually wrap the statements in one
SQLite transaction in this driver version, then a partial failure between the booking insert
(lines 438-452) and the tick insert (lines 465-473) could commit a booking with **no
occupancy ticks** — permanently corrupting availability (the booking won't block future
slots). The code *assumes* the throw rolls everything back.

**Recommendations:**
- 🔴 Add a concurrency test against a real (throwaway) LibSQL instance: open two clients,
  fire the same idempotency key and the same contested slot near-simultaneously, and assert
  exactly one booking row + exactly one set of ticks, and that the loser got
  `SlotConflictError`. Run it in CI against an ephemeral instance (see §7).
- Verify `drizzle-libsql`'s `db.transaction` truly batches into `BEGIN/COMMIT`. If unsure,
  issue `BEGIN IMMEDIATE` explicitly via `client.execute` and manage commit/rollback
  manually; this removes the dependency on driver behavior the repo already distrusts.
- Either delete `host_mutexes` (redundant with the single-writer lock + tick unique) or
  replace it with an actual advisory lock primitive. Document the *true* serialization story
  in `AGENTS.md`.
- Consider seeding `host_occupancy_ticks` **before** the `bookings` insert, so a tick
  collision still aborts before a booking row exists — cheaper to reason about.

---

## 4. 🟠 `host_occupancy_ticks` is write-only and never pruned — and no cancellation path exists

- The tick table is written in `insertOccupancyTicks` (`create-booking-handler.ts:269-283`)
  but **never read** for conflict detection (the engine reads `bookings` via
  `getBookingsInRange`, `create-booking-handler.ts:122-151`). Its only role is the
  write-time unique guard (§3) — which is fine, but it must be kept in lockstep with
  `bookings`.
- There is **no cancellation/refund handler** anywhere in the repo. If a booking is cancelled,
  its `host_occupancy_ticks` rows are never deleted → that host permanently loses those
  minutes of capacity. Over time, capacity silently leaks to zero.
- The `status` enum includes `cancelled`/`rejected` (`schema.ts:117`) but nothing transitions
  into them.

**Recommendations:**
- Add a `cancelBooking` (or status-update) path that, in the same transaction, flips the
  booking status **and** deletes its `host_occupancy_ticks` rows. Idempotent via the booking
  `uid`/idempotency key.
- Add an index/query to detect orphaned ticks (ticks whose `booking_id` no longer exists in
  `bookings`) as a reconciliation safety net.
- Add a `cancelled_at` timestamp and a soft-delete policy rather than relying solely on the
  `status` string.

---

## 5. 🟠 Secret & configuration handling leaks into source

### 5.1 `daily.ts` reads `.env` from the filesystem directly
`getDailyApiKey` parses `.env` with a regex via `readFileSync` (`daily.ts:1-17`), even though
`apply-schema.ts` and the rest of the app rely purely on `process.env`. This is inconsistent
and a production footgun:
- It reads a file from the current working directory at request time on every booking that
  uses Daily — unnecessary I/O and a CWD coupling.
- The regex doesn't handle `#` comments, quoted multiline values, or `export ` prefixes.
- It contradicts the documented model in `AGENTS.md` ("scripts never load `.env`").

**Recommendation:** Delete the `readFileSync` fallback. Require `DAILY_API_KEY` in
`process.env` (set via `source .env` / a real loader at process entry, or a secret manager).
`createDailyRoom` already gracefully returns `null` when the key is absent
(`daily.ts:30-33`) — that's the correct no-key behavior; keep it and drop the loader.

### 5.2 Hardcoded address/phone in `notifications.ts`
`[REDACTED_ADDRESS]`, a `MAPS_URL`, and `[REDACTED_PHONE]` are
hardcoded as fallbacks (`notifications.ts:15, 22, 26, 41, 45`). Business/PII-ish config
belongs in configuration, not source. They're only used when `loc.address`/`loc.phone` is
absent, but defaults still shouldn't ship in code.

**Recommendation:** Pull these from env/tenant config; if unset, leave the field empty and
render a neutral "contact us" fallback rather than a specific address.

### 5.3 `credentials.encrypted_token` is an unimplemented seam
The column exists (`schema.ts:185-192`) but there is no encryption helper, key management,
read path, or write path anywhere. Storing OAuth tokens in a DB text column (even "encrypted")
needs a defined scheme: envelope encryption with a KMS/secret-store key, key rotation, and a
clear owner. Shipping the column now invites someone to write plaintext tokens into it.

**Recommendation:** Before any calendar-integration work, define the encryption-at-rest
scheme (e.g., app-managed key from env/KMS, AES-GCM per token) **or** store tokens in a
dedicated secret manager and keep only a reference in `credentials`. Document the decision.

---

## 6. 🟡 Correctness & efficiency gaps in availability/booking math

### 6.1 Recomputing the whole slot grid per candidate host (N+1 inside a write tx)
For `round_robin` and `collective`, the handler calls `isHostFree`/`assertHostStillFree` once
**per host**, and each call re-runs `computeAvailability` over a full padded day
(`create-booking-handler.ts:181-224, 398-427`). `computeAvailability` fans out 3 parallel
queries (`availability-engine.ts:84-88`), so this is `O(hosts)` extra query bursts *inside* a
transaction that is supposed to be short and serializing. Fine for 2–3 hosts; degrades as
teams grow.

**Recommendation:** Compute each host's availability **once** (you already do this at
query time in `computeMultiHostAvailability`), then inside the transaction do only the cheap
"does the exact requested interval overlap an existing booking+buffer for this host?" check
— a single `overlaps` test against the host's already-known bookings, not a full grid
regen. Even simpler: replace `isHostFree`'s `computeAvailability` call with a direct
`SELECT 1` overlap query against `bookings` for that host + slot. This also removes the
`HOST_FREE_RANGE_PAD_MINUTES = 1440` day-padding hack (`create-booking-handler.ts:82`).

### 6.2 Occupancy-tick granularity rounds out to whole minutes
`occupancyTicks` floors start/end to minute ticks (`create-booking-handler.ts:250-267`).
A booking at `10:00:30`–`11:00:29` claims the `10:00` and `11:00` minute-ticks even though it
only partially occupies them → up to ~1 minute of false unavailability at each edge. For a
minute-grained scheduler this is usually acceptable, but it should be **documented** and the
booking engine should pin slot starts to minute boundaries (the Zod schema could enforce
`:ss` is `:00`, or the handler could align).

### 6.3 Input validation: slot direction/duration not checked at parse time
`CreateBookingInput` (`create-booking-handler.ts:25-40`) validates format but not that
`slotEndUtc > slotStartUtc`, nor that the duration equals `lengthMinutes`. A buggy/malicious
caller could request a 1-minute "slot" for a 30-minute event. (The engine's
`assertHostStillFree` ultimately rejects non-slots, so it's defended — but fail fast at the
boundary.)

**Recommendation:** Add `.refine((v) => end > start)` and a duration check in the Zod schema;
treat malformed input as 400, not 409/500.

### 6.4 Unbounded availability range
`computeAvailability` walks day-by-day for the *entire* `rangeStartUtc`–`rangeEndUtc`
(`availability-engine.ts:118-128`). A caller can request a 1-year window → up to 365 days ×
windows, and `computeMultiHostAvailability` multiplies that by host count. No upper bound is
enforced.

**Recommendation:** Clamp the max range (e.g., 60 days) in the tool/handler boundary and
document it; return a clear error beyond that.

### 6.5 DST edge-case test coverage
The day-walk and `exactWallClock` logic is the riskiest and best part of the code. Add
explicit, named tests for: (a) a working window that falls **entirely inside** the spring-
forward gap (nonexistent wall clock) — assert no slot is produced or it shifts correctly;
(b) a window that **spans** the fall-back fold (one wall clock maps to two UTC instants) —
assert interval resolution is unambiguous and deterministic.

---

## 7. 🟡 Testing & CI posture

- **The only test that exercises the real schema + transaction + tick-unique path
  (`libsql-instance.test.ts`) self-skips without a live instance env.** So in default CI,
  **no test validates the production schema or the conflict path against a real DB**
  (`libsql-instance.test.ts`, per `AGENTS.md`).
- Handler tests run against the **divergent** `test-db.ts` schema (§2), so they can't catch
  the drift or the production indexes.
- `npm test` runs only four hardcoded files (`package.json`); new `*.test.ts` files are
  silently skipped — easy to ship untested code.

**Recommendations:**
- Stand up an **ephemeral Turso/dev instance** in CI (or `sqld` via `npm run libsql:start`)
  and run `libsql-instance.test.ts` there, including a concurrency test (§3) and a
  cancellation test (§4). Tear it down after.
- Generate the test DB from `schema.sql` (§2) so tests and prod share one definition.
- Switch the test runner to a glob (e.g., `tsx --test "*.test.ts"`) or document loudly that
  new test files must be added to `package.json`.
- Add a schema-drift check to CI (introspect live/dev instance vs `schema.ts`).

---

## 8. 🟢 Lower-severity / polish

- **Error → HTTP mapping is missing.** `SlotConflictError.statusCode` /
  `LocationNotOfferedError.statusCode` (`create-booking-handler.ts:55-61`) are never read.
  Add a central mapper (or an HTTP framework like Hono/Express) so domain errors become 409/400
  instead of 500. If the HTTP layer lives outside this repo, document the contract.
- **Swallowed async error.** `void sendBookingConfirmation(...).catch(() => {})`
  (`create-booking-handler.ts:337`) drops confirmation failures silently. In prod, a failed
  email should be retried/queued. At minimum, log a structured warning with the booking `uid`.
- **`replayExistingBooking` uses a cast** `(existing as unknown as {location?}).location`
  (`create-booking-handler.ts:300`) — `location` is a real column; read `existing.location`
  directly.
- **Logging is `console.*`.** Replace with a structured logger (pino/winston) + correlation
  IDs once this is service-facing.
- **`users.metadata` / `event_types.locations` JSON** are parsed ad hoc; consider a Zod
  schema for the location shape so malformed JSON fails loudly rather than defaulting to `[]`
  / `inPerson`.
- **`randomUUID()`** for `uid` is correct (`crypto`). Keep it; don't switch to sequential IDs
  for public-facing identifiers.

---

## 9. Suggested sequencing

| # | Action | Severity | Effort |
|---|---|---|---|
| 1 | Single-source schema; tests boot from `schema.sql`; delete `test-db.ts` DDL | 🔴 | M |
| 2 | Add concurrency test vs real LibSQL; verify `db.transaction` atomicity | 🔴 | M |
| 3 | Remove `daily.ts` `.env` reader; move address/phone to config | 🟠 | S |
| 4 | Add cancellation path that prunes `host_occupancy_ticks` | 🟠 | M |
| 5 | Replace per-host `computeAvailability` re-check with a direct overlap query | 🟡 | M |
| 6 | Define `credentials` encryption scheme or move to secret manager | 🟠 | M |
| 7 | Range clamp + 400 on bad slot direction/duration | 🟡 | S |
| 8 | CI: run live-instance tests (incl. concurrency + cancel) + schema-drift check | 🟡 | M |
| 9 | Error→HTTP mapper, structured logging, DST edge tests | 🟢 | S/M |

**Effort key:** S = <½ day, M = ½–2 days.

---

## 10. Bottom line

The architecture is sound where it matters most — the domain model is clean, DST math is
correct, and the booking write is idempotent. The exposure is in *operational* correctness:
the schema has drifted across three copies (and tests run on the weakest one), the
concurrency safety argument is unverified and partly rests on a no-op "lock", and
configuration/secrets are leaking into source. None require a rewrite; items 1–4 above are the
difference between "clever prototype" and "safe to put on the critical path."
