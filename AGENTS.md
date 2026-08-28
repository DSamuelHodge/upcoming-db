# AGENTS.md

## What this is
Flat single-package TypeScript repo (all `.ts` at root; no `src/`): a scheduling/booking
data layer on LibSQL/Turso — availability engine, multi-host routing, atomic booking writes.
ESM (`"type": "module"`); `tsconfig.json` only includes root `*.ts`.

## Commands
- `npm test` — runs `tsx --test` over four test files listed explicitly in package.json.
  A new `*.test.ts` is NOT run unless added to that script.
- Single file/test: `npx tsx --test availability-engine.test.ts`
  (add `--test-name-pattern "<title>"` for one test).
- `npm run typecheck` — `tsc --noEmit`; there is no build step.
- `npm run schema:apply` — executes `schema.sql` against a live LibSQL instance.
- `npm run libsql:start` — runs `sqld`, a global binary NOT installed via npm.

## Env gotchas
- No dotenv dependency; npm scripts never load `.env` (only `daily.ts` parses it itself).
  Pass vars inline: `LIBSQL_URL=http://127.0.0.1:8080 npm run schema:apply`.
- `LIBSQL_URL`/`TURSO_DATABASE_URL` must be `http(s)://` or `libsql://` —
  `apply-schema.ts` and `drizzle.config.ts` deliberately reject `file:`/`.db` URLs.
  (Tests are exempt; see below.)

## Credentials
Stored locally in `.env` (gitignored; the repo is public on GitHub at
`github.com/DSamuelHodge/upcoming-db` — `.env` has never been committed; keep it that way).
- Daily: `DAILY_API_KEY` in `.env` is a temporary dev/testing key (revoke after
  conclusion); the real key belongs in repo Actions secrets and/or `pass`.
- Turso: `TURSO_AUTH_TOKEN` / `LIBSQL_URL` are DB-scoped. The token authenticates
  directly at the DB endpoint (`...turso.io/v2/pipeline`), NOT through the management
  API. `pass show turso/api-token` holds a management session JWT (works with the
  `turso` CLI via `TURSO_API_TOKEN`) but it is SHORT-LIVED (~7 days) — when it
  expires, refresh it with `turso auth login --headless` and re-store it in Pass.
  DB-scoped tokens for instances are minted with `turso db tokens create <db-name>`
  (the one in `.env` does not expire). Production instance is `upcoming-db-v2`
  (endpoint rotated 2026-08-28 per Item 0.1; the old exposed instance is destroyed —
  never reuse or mention the old hostname).
- Verify the live DB with a read-only pipeline query (DB token as Bearer):
  `curl -H "Authorization: Bearer $TURSO_AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT uid,status FROM bookings"}}]}' \
    https://upcoming-db-[REDACTED_HOST].aws-us-west-2.turso.io/v2/pipeline`

## Schema lives in two places — keep them in sync
`schema.ts` (canonical Drizzle) and `schema.sql` (applied identically to tests via
`schema-sql.ts` and to prod via `apply-schema.ts`). `test-db.ts` no longer holds its own
DDL, and `libsql-instance.test.ts` derives expected tables from `schema.ts`. No migrations
are committed (`drizzle/` is empty/untracked) — a schema change means editing both files;
the live instance may additionally need a one-off additive `ALTER` because
`CREATE TABLE IF NOT EXISTS` never upgrades existing tables. The column-level drift guard
(`npm run drift:check`, nightly non-blocking CI job) catches divergence.

## Workflow
- Git: feature branch + PR into `main`. No direct commits to `main` going forward;
  CI (added by Item 0.5 of the plan) will gate merges once it exists.
- Canonical remediation plan: `Docs/remediation-plan.md` (v2, with decision log) —
  read it before doing any remediation work; `Docs/architecture-analysis.md` is the source analysis.
- Redaction policy: no real addresses, phone numbers, or live hostnames in docs or code —
  use `[REDACTED_ADDRESS]` / `[REDACTED_PHONE]` / `[REDACTED_HOST]` placeholders.
  (Code-side scrub of `notifications.ts` and the test fixture is pending as Item 0.)

## Architecture rules
- `availability-engine.ts` is pure domain code: depends only on the `AvailabilityRepository`
  interface, never on Drizzle/SQL. Keep it so; test with an in-memory fake repo. DST
  correctness comes from walking day-by-day in the schedule's local timezone — do not
  refactor into UTC arithmetic.
- `multi-host-routing.ts` does no slot/DST math; it composes `computeAvailability` per host.
  Round-robin host choice at query time is a preview only — the real host is re-verified
  and assigned inside the booking transaction (`create-booking-handler.ts`).
- Every event type has rows in `event_type_hosts`, including `individual` ones.
  `loadEventType()` throws on zero hosts; don't reintroduce owner_user_id branching.
- Buffers are snapshotted onto the booking row at insert time; all conflict/occupancy logic
  reads the booking's stored buffers, not the live event type's. The commit-time conflict
  check expands each candidate booking's span by its own stored buffers in SQL
  (`bufferedOverlapExists`) — no fixed window pad — while the availability-engine re-check
  inside the transaction only covers working-hours/notice/alignment over a ±48h window.
- Cancellation (`cancelBookingHandler`) stamps `cancelled_at` and deletes the booking's
  occupancy ticks + `booking_hosts` rows in the SAME transaction — an unpruned tick blocks
  the host's slot forever. Replays are idempotent by uid/idempotencyKey; `findOrphanedTicks`
  is the reconciliation safety net for bookings lost without pruning.
- Concurrency model: `host_occupancy_ticks` unique (host, minute-tick) is SQLite's stand-in
  for an exclusion constraint and is the actual serialization backstop — a losing tick insert
  surfaces as `SlotConflictError` in `createBookingHandler`, which also owns the SQLITE_BUSY
  retry. drizzle-libsql ignores `BEGIN IMMEDIATE`; correctness rests on the tick index plus
  Turso Cloud's single-primary write serialization, verified by the live two-client
  contention test in `libsql-instance.test.ts`. The former `host_mutexes` table was a no-op
  (its INSERT-ON-CONFLICT released at statement end, not commit) and was removed.

## Tests
- `node:test` + `assert/strict` via tsx — no vitest/jest.
- Handler tests use `openTestDb()`: throwaway `file:booking-test-*.db` SQLite files,
  auto-deleted. `file:` URLs are fine here, only production paths reject them.
- `libsql-instance.test.ts` self-skips unless `LIBSQL_URL`/`TURSO_DATABASE_URL` points at a
  live instance — a green `npm test` does not mean those ran. Same for the live Daily.co
  tests (`daily.test.ts` + the `dailyTest` flow tests), which self-skip without
  `DAILY_API_KEY` and make real API calls when it is set.
- Engine tests inject a fixed `now`; the spring-forward/fall-back tests are sensitive to the
  day-walk loop in `computeAvailability`.

## Stubs
`notifications.ts` only logs — the AgentMail send is an unimplemented seam (content is
built for real; only delivery is stubbed). Don't treat these as real integrations.

## Daily.co rooms
`daily.ts` is a real integration (key from `DAILY_API_KEY`; all failures soft-fail and
are logged). Room policy lives in `resolveChosenLocation` (create-booking-handler.ts):
a pre-configured `url` on the event type's menu entry wins; else `DAILY_DEFAULT_ROOM_URL`;
else a per-booking room is minted (name = booking uid, join window = slot ±
`DAILY_ROOM_GRACE_SECONDS`). Minting happens BEFORE the write transaction (never hold
the write lock for an API call) and is idempotent by room name (duplicate → GET
recovery). Only MINTED rooms carry the `dailyRoomName` marker in `bookings.location`;
`cancelBookingHandler` best-effort deletes only those. Rooms self-expire via nbf/exp.
