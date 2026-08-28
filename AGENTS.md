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
Stored locally in `.env` (gitignored; repo has no commits, so never in history).
- Daily: `DAILY_API_KEY` is an exact copy of `pass show services/daily/api-key`.
- Turso: `TURSO_AUTH_TOKEN` / `LIBSQL_URL` are DB-scoped. The token authenticates
  directly at the DB endpoint (`...turso.io/v2/pipeline`), NOT through the management
  API. `pass show turso/api-token` is the original management token but currently
  returns "invalid api token" against api.turso.tech — do NOT rely on Pass to mint new
  DB tokens; the working token already lives in `.env`.
- Verify the live DB with a read-only pipeline query (DB token as Bearer):
  `curl -H "Authorization: Bearer $TURSO_AUTH_TOKEN" -H "Content-Type: application/json" \
    -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT uid,status FROM bookings"}}]}' \
    https://upcoming-db-[REDACTED_HOST].aws-us-west-2.turso.io/v2/pipeline`

## Schema lives in three places — keep them in sync
`schema.ts` (Drizzle), `schema.sql` (applied to instances), and the `DDL` array in
`test-db.ts`. No migrations are committed (`drizzle/` is empty/untracked). A schema change
means editing all three plus the expected-tables list in `libsql-instance.test.ts`.

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
  reads the booking's stored buffers, not the live event type's.
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
  live instance — a green `npm test` does not mean those ran.
- Engine tests inject a fixed `now`; the spring-forward/fall-back tests are sensitive to the
  day-walk loop in `computeAvailability`.

## Stubs
`daily.ts` returns null (no throw) when `DAILY_API_KEY` is unset; `notifications.ts` only
logs — the AgentMail send is an unimplemented seam. Don't treat these as real integrations.
