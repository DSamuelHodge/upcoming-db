# Remediation Plan — `upcoming-db`

**Source:** `architecture-analysis.md` (Principal Architect review)
**Order:** Critical → Low. Each phase lists concrete file changes and the verify step (`npm run typecheck` + `npm test`).

---

## Phase 1 — 🔴 Schema triple-source (analysis §2)
**Goal:** eliminate the divergent third copy (`test-db.ts` `DDL`) so tests run on the production-identical schema.

1. **`test-db.ts`** — delete the `DDL` array (lines 9–87). Instead read `schema.sql` and apply its statements via the same `statementsFromSql` splitter already in `apply-schema.ts` (move that helper to a shared `src/schema-sql.ts` or duplicate locally). `openTestDb` then boots the throwaway `file:` db from `schema.sql`, not hand-written DDL. Tests now exercise `availability_schedule_idx`, `event_type_owner_slug_unique`, `bookings_host_time_idx`, `host_occupancy_ticks_booking_idx`, `booking_host_unique`, and the `credentials` table — closing the 6-object gap.
2. **Drift guard** — add `scripts/check-schema-drift.ts` (or fold into `libsql-instance.test.ts`): introspect a live/dev instance `sqlite_master` and assert every table/index name from `schema.ts` is present. Wire into `package.json` `test`.
3. **`AGENTS.md`** — rewrite the "Schema lives in three places" note to "two places (`schema.ts` canonical, `schema.sql` applied to both tests and prod); drift check enforces parity."

## Phase 2 — 🔴 Concurrency / atomicity (analysis §3)
**Goal:** prove the booking transaction is atomic and remove the no-op lock.

1. **Concurrency test** (real instance, `libsql:start`) — open two clients, fire the same contested slot with *different* idempotency keys near-simultaneously; assert exactly one `bookings` row, exactly one set of `host_occupancy_ticks`, and the loser throws `SlotConflictError`. This validates `db.transaction` actually wraps (no orphan booking without ticks).
2. **Remove `host_mutexes`** — delete `acquireHostMutex` (`create-booking-handler.ts:238-246`) and its calls (`:387`), and the `hostMutexes` table from `schema.ts`/`schema.sql`/`test-db` (now schema.sql). Document the *true* serialization story in `AGENTS.md`: single-writer commit lock + `host_occupancy_tick_unique` guard + `SQLITE_BUSY` retry (`:322-344`).
3. **Hardening fallback** — if the Phase-2.1 test reveals partial commits, replace `db.transaction` with an explicit `BEGIN IMMEDIATE … COMMIT` via `client.execute` in `commitBooking`.

## Phase 3 — 🟠 Secret & config leakage (analysis §5.1, §5.2)
1. **`daily.ts`** — delete the `readFileSync(".env")` fallback (lines 1–17, usage at `:29`). Require `DAILY_API_KEY` from `process.env`; `createDailyRoom` already returns `null` when absent. Aligns with `AGENTS.md` ("scripts never load `.env`").
2. **`notifications.ts`** — remove hardcoded `4022 Green Stripe Lane…`, `MAPS_URL`, and `(614) 407-4920` (`:15,22,26,41,45`). Read from env (`BUSINESS_ADDRESS` / `BUSINESS_MAPS_URL` / `BUSINESS_PHONE`); if unset, emit empty + a neutral "contact us" line rather than a specific address.

## Phase 4 — 🟠 Cancellation path + tick pruning (analysis §4) and credentials scheme (§5.3)
1. **`cancelBooking`** — new handler: in one `db.transaction`, set `status='cancelled'` + a new `cancelled_at` timestamp, and `DELETE FROM host_occupancy_ticks WHERE booking_id = ?` (and `booking_hosts`). Idempotent via `uid`/`idempotencyKey`.
2. **Schema** — add nullable `cancelled_at` to `bookings` in `schema.ts`, `schema.sql`, and (via schema.sql) tests.
3. **Reconciliation** — add a query/util to find orphaned ticks (ticks whose `booking_id` no longer exists) as a safety net; cover with a test.
4. **`credentials` encryption** (§5.3) — before any calendar work: add `encryptToken`/`decryptToken` (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` env) with a documented scheme, or switch to a secret-manager reference. Add a write/read path test even though unused.

## Phase 5 — 🟡 Efficiency + input validation (analysis §6.1, §6.3, §6.4)
1. **§6.3** — add `.refine` to `CreateBookingInput` (`create-booking-handler.ts:25-40`): `slotEndUtc > slotStartUtc` → fail fast 400 (not 409/500).
2. **§6.4** — clamp `rangeStartUtc…rangeEndUtc` (e.g. 60 days) in `computeAvailability`/`computeMultiHostAvailability` boundary; throw a clear error beyond it.
3. **§6.1** — replace the per-host `computeAvailability` re-check inside the tx with a direct overlap `SELECT 1` against `bookings` for that host + exact slot (reuse `getBookingsInRange` shape). Delete `HOST_FREE_RANGE_PAD_MINUTES = 1440` (`:82`) and the day-padding hack in `isHostFree` (`:188-193`). Add handler tests.

## Phase 6 — 🟡 DST edge tests + CI (analysis §6.5, §7)
1. **DST tests** — named engine tests: (a) a working window entirely inside the spring-forward gap → no slot / correct shift; (b) a window spanning fall-back fold → unambiguous, deterministic interval. (Existing day-walk logic is correct; lock it with tests.)
2. **CI** — switch `package.json` `test` to glob discovery (`tsx --test`) so new `*.test.ts` are never silently skipped; run `libsql:start` + live-instance tests (concurrency + cancel) + drift check in CI, then tear down.

## Phase 7 — 🟢 Polish (analysis §8)
- **Error→HTTP mapper** — add `mapErrorToHttp(err)` (409 `SlotConflictError`, 400 `LocationNotOfferedError`/validation, else 500); document the contract for the HTTP layer.
- **`create-booking-handler.ts:337`** — stop swallowing confirmation errors; log a structured warning with `uid`.
- **`:300`** — replace the `as unknown as {location?}` cast with `existing.location`.
- **Logging** — replace `console.*` with a minimal structured logger + correlation id (optional, defer if no HTTP layer yet).
- **JSON parsing** — Zod-parse `users.metadata` / `event_types.locations` so malformed JSON fails loudly.

---

**Verify after each phase:** `npm run typecheck` and `npm test` (plus the live-instance tests when an instance env is set).
