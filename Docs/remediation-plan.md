# Remediation Plan — `upcoming-db`

> **v2 (2026-08-28) supersedes v1.** Full v1 text is preserved at commit `820caeb`.
> Source analysis: [`Docs/architecture-analysis.md`](./architecture-analysis.md), plus a
> second-pass adversarial review that re-verified every claim against source.
> Real addresses, phone numbers, and hostnames are scrubbed to `[REDACTED_*]` placeholders
> by policy (2026-08-28) — audit records do not carry live PII or environment identifiers.

---

## What changed from v1

| Change | Why |
|---|---|
| New **Item 0** (env/PII hygiene) moved ahead of everything | Address/phone in `src/notifications.ts` and the live Turso hostname in `AGENTS.md` were already public on GitHub; a 20-minute fix should not wait behind multi-day schema work. |
| New **Item 0.1** — Turso endpoint rotation as its own administrative item | Renaming/re-provisioning the DB instance is Turso-side work the code fix does not address. |
| New **Item 0.5** — hermetic GitHub Actions CI before any engineering phase | v1 said "wire into CI" four times; `.github/` did not exist. CI is infrastructure, not an end-phase checkbox. |
| v1 Phase 6.1 (DST test suite) trimmed to a single delta test | Spring-forward gap-start (`src/availability-engine.test.ts:41`), gap-end (`:206`), fall-back fold first-occurrence (`:87`), and overnight-into-gap (`:190`) tests already exist. Only the "both ends nonexistent on the same local day" case is missing. |
| v1 Phase 5 (N+1 fix) implementation **corrected** | A bare `SELECT 1` overlap query silently drops three checks `computeAvailability` was buying: working-hours containment, minimum booking notice (`earliestBookable`), and slot-grid alignment. The fix must preserve all three. |
| Schema drift guard demoted from PR gate to scheduled/nightly, non-blocking | CI trust boundaries: PR checks stay deterministic and network-free; live-Turso checks are flaky, need secrets, and risk tier concurrency limits. |
| v1 Phase 2 constraint added | Run the two-client contention test against **real Turso Cloud**, not just local `sqld`, before deleting `host_mutexes` — topologies are not guaranteed to serialize identically. |

## Decision log — 2026-08-28

1. **Doc structure:** in-place rewrite; single canonical file. v1 lives in git history (`820caeb`). No `-v2.md` sprawl.
2. **Docs PII exposure:** scrub real addresses/phones/hostnames across all current and historical documentation with `[REDACTED_*]` placeholders. Code fixtures (`src/create-booking-handler.test.ts:14-15`) are scrubbed in Item 0, not here.
3. **Commit style:** feature branch + PR into `main` from now on; CI gates merges once Item 0.5 lands.

---

## Item 0 — 🔴 Env/PII hygiene (hours, do first)

1. **`src/notifications.ts`** — remove hardcoded `[REDACTED_ADDRESS]`, `MAPS_URL`, and `[REDACTED_PHONE]` (`:15, 22, 26, 41, 45`). Read from env (`BUSINESS_ADDRESS` / `BUSINESS_MAPS_URL` / `BUSINESS_PHONE`); if unset, emit empty + a neutral "contact us" line.
2. **`src/daily.ts`** — delete the `readFileSync(".env")` homemade parser (lines 1–17, usage at `:29`). Require `DAILY_API_KEY` from `process.env`; `createDailyRoom` keeps returning `null` when absent. Aligns with `AGENTS.md` ("scripts never load `.env`").
3. **`src/create-booking-handler.test.ts:14-15`** — replace the real address/phone fixture with placeholder values (`[REDACTED_ADDRESS]` / a fake phone).
4. **`AGENTS.md:35`** — hostname scrubbed to `upcoming-db-[REDACTED_HOST].aws-us-west-2.turso.io` (done in this PR). Grep remains clean.

## Item 0.1 — 🔴 Turso endpoint rotation (administrative, parallel with Item 0)

> **Done 2026-08-28:** provisioned `upcoming-db-v2`, imported schema (data parity
> verified — all app tables empty post fixture-purge), minted a fresh DB-scoped token,
> updated `.env` + repo Actions secrets, verified drift check + live suite against the
> new endpoint, destroyed the exposed instance (old hostname now 404).

Threat model: an open-repo DB hostname is a standing target for scanners, DDoS probes, and pool-exhaustion against a managed tier — unnecessary surface area even with valid auth.

**Repo part (agent):** done — `AGENTS.md` now uses a placeholder host.

**Turso-side (owner/admin, in order):**
1. Provision the new database instance (or rename via `turso` CLI).
2. Rotate connection credentials; update `TURSO_AUTH_TOKEN` / `LIBSQL_URL` in local `.env` and any production env.
3. Tear down or deprecate the exposed instance.

Caveat from `AGENTS.md`: the management token in `pass` currently returns "invalid api token" against `api.turso.tech` — do rotation through the Turso CLI/dashboard with a working credential, not `pass show turso/api-token`.

## Item 0.5 — 🔴 Hermetic CI (before Phase 1)

`.github/workflows/ci.yml`, on push/PR to `main`:
- `npm ci`
- `npm run typecheck`
- `npm test` (live-instance tests self-skip without `LIBSQL_URL`/`TURSO_DATABASE_URL` — no secrets, no network, deterministic).

Trust boundary: PR gates are hermetic. Anything needing a live instance (drift guard, contention test) is a separate scheduled/nightly, non-blocking job.

## Phase 1 — 🟠 Schema single-source

1. **`src/test-db.ts`** — delete the hand-written `DDL` array (lines 9–87). `openTestDb` reads `src/schema.sql` and applies it via the `statementsFromSql` splitter (move from `scripts/apply-schema.ts` to a shared module or duplicate locally). Tests then exercise the six objects the DDL copy was missing: `availability_schedule_idx`, `event_type_owner_slug_unique`, `event_type_hosts_event_type_idx`, `bookings_host_time_idx`, `host_occupancy_ticks_booking_idx`, `booking_host_unique`, plus the `credentials` table — including the real `event_type_owner_slug_unique` rejection of duplicate `(owner, slug)` pairs.
2. **Drift guard** — scheduled/nightly, non-blocking job: introspect live `sqlite_master`, assert every table/index name in `src/schema.ts` is present. Not a PR gate (see Item 0.5 trust boundary).
3. **`AGENTS.md`** — update "Schema lives in three places" to: two sources (`src/schema.ts` canonical, `src/schema.sql` applied identically to tests and prod), drift check enforces parity.

## Phase 2 — 🟠 Concurrency / atomicity

1. **Contention test against real Turso first** — two clients, same slot, different idempotency keys, fired near-simultaneously; assert exactly one `bookings` row, one tick set, loser throws `SlotConflictError`. Local `sqld` is a useful first pass but is not proof: run the deciding round against Turso Cloud (single-primary topology) before trusting the model. Optionally use Turso DB branching for an ephemeral prod-schema instance per run (check plan tier support first).
2. **Remove `host_mutexes`** — only after 2.1 passes. Delete `acquireHostMutex` (`src/create-booking-handler.ts:238-246`), its call (`:387`), and the `hostMutexes` table from `src/schema.ts`/`src/schema.sql`. Document the real serialization story in `AGENTS.md`: single-writer commit lock + `host_occupancy_tick_unique` + `SQLITE_BUSY` retry (`:322-344`).
3. **Fallback** — if 2.1 reveals partial commits, replace `db.transaction` with explicit `BEGIN IMMEDIATE … COMMIT` via `client.execute` in `commitBooking`.

## Phase 3 — 🟠 Cancellation + tick pruning + credentials encryption

1. **`cancelBooking`** — one transaction: `status='cancelled'` + new nullable `cancelled_at`, `DELETE FROM host_occupancy_ticks WHERE booking_id = ?` (and `booking_hosts`). Idempotent via `uid`/`idempotencyKey`.
2. **Schema** — add nullable `cancelled_at` to `bookings` in `src/schema.ts` + `src/schema.sql`.
3. **Reconciliation** — query for orphaned ticks (booking gone, tick present) as a safety net; test it.
4. **`credentials` encryption** — `encryptToken`/`decryptToken` (AES-256-GCM, key from `TOKEN_ENCRYPTION_KEY` env) with documented scheme, or a secret-manager reference. Add a write/read test even though unused today.

## Phase 4 — 🟡 Efficiency fix, correctness-preserving

**Constraint:** do not replace `isHostFree`'s `computeAvailability` call with a bare overlap `SELECT` — that silently drops three checks: (1) working-hours containment, (2) `earliestBookable` notice, (3) slot-grid alignment (an off-grid `09:07–09:37` request must stay rejected by construction).

1. Shrink the window handed to `computeAvailability` inside the transaction to the minimum needed (current pad is `bufferBefore/After + HOST_FREE_RANGE_PAD_MINUTES`), or replicate the three checks explicitly in a lighter function. Either is acceptable; the checks may not disappear.
2. Delete `HOST_FREE_RANGE_PAD_MINUTES = 1440` (`src/create-booking-handler.ts:82`) and the day-padding hack in `isHostFree` (`:188-193`) as part of this.
3. **Input validation** — `.refine` on `CreateBookingInput` (`:25-40`): `slotEndUtc > slotStartUtc` → fail fast 400 (not 409/500). Clamp availability ranges (e.g. 60 days) in `computeAvailability`/`computeMultiHostAvailability`.

## Phase 5 — 🟡 DST delta test

Single addition to `src/availability-engine.test.ts`: a working window with **both ends nonexistent** on the same local day (`02:15–02:45` on 2026-03-08, America/New_York) — assert it resolves to zero slots via the `firstValidAtOrAfter`/`lastValidAtOrBefore` fallback producing `end <= start`. Everything else already exists (`:41`, `:87`, `:190`, `:206`).

## Phase 6 — 🟢 Polish

- **`mapErrorToHttp(err)`** — 409 `SlotConflictError`, 400 `LocationNotOfferedError`/validation, else 500; document the contract for the HTTP layer.
- **`src/create-booking-handler.ts:337`** — stop swallowing confirmation errors; log a structured warning with `uid`.
- **`:300`** — replace the `as unknown as {location?}` cast with `existing.location`.
- **Structured logger** — replace `console.*` (optional; defer if no HTTP layer yet).
- **Zod-parse** `users.metadata` / `event_types.locations` so malformed JSON fails loudly.

---

**Verify after every item/phase:** `npm run typecheck` + `npm test`; live-instance tests and the drift guard run in the scheduled CI job once Item 0.5 exists. Merges go through feature-branch PRs with CI green.
