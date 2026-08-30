# API contract — upcoming-db

Status: **handler contract** (there is no HTTP layer yet — the functions in
`src/create-booking-handler.ts` / `src/multi-host-routing.ts` are the backend). This
document is the authoritative reference for the exact schema and the exact
parameters each operation accepts and returns.

Auth model: callers present a **secret** (API key / token) that the future HTTP
layer or MCP server validates before invoking handlers. Nothing in this repo
authenticates end users today; do not expose the DB token to clients.

---

## 1. Database schema (exact, from `src/schema.ts` — Drizzle → SQLite)

All timestamps are **ISO 8601 UTC strings** (e.g. `2027-06-01T10:00:00.000Z`).
All times that drive availability math are UTC instants; wall-clock `HH:MM`
values are schedule-local and interpreted in the schedule's IANA timezone.

### `users`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| email | TEXT | NOT NULL UNIQUE |
| username | TEXT | NOT NULL UNIQUE |
| timezone | TEXT | NOT NULL DEFAULT 'UTC' |
| metadata | TEXT | NOT NULL DEFAULT '{}' (JSON object; strict-parse pending first consumer) |

### `schedules`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| user_id | INTEGER | NOT NULL → users.id, UNIQUE (one schedule per user) |
| name | TEXT | NOT NULL |
| timezone | TEXT | NOT NULL (IANA name; source of truth for availability) |

### `availability`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| schedule_id | INTEGER | NOT NULL → schedules.id (indexed) |
| day_of_week | INTEGER | 0 (Sun) – 6 (Sat); NULL if date-specific |
| date_override | TEXT | 'YYYY-MM-DD'; NULL if recurring |
| start_time | TEXT | NOT NULL, 'HH:MM' local wall clock |
| end_time | TEXT | NOT NULL, 'HH:MM' local wall clock |

A rule has exactly one of `day_of_week` / `date_override` set.

### `event_types`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| owner_user_id | INTEGER | NOT NULL → users.id (creator of record, not necessarily a host) |
| slug | TEXT | NOT NULL; UNIQUE (owner_user_id, slug) |
| length_minutes | INTEGER | NOT NULL |
| slot_interval_minutes | INTEGER | NULL → engine defaults to length_minutes |
| buffer_before | INTEGER | NOT NULL DEFAULT 0 |
| buffer_after | INTEGER | NOT NULL DEFAULT 0 |
| scheduling_type | TEXT | NOT NULL DEFAULT 'individual'; enum: `individual` \| `round_robin` \| `collective` |
| locations | TEXT | NOT NULL DEFAULT '[]' (JSON array — see Locations menu) |
| min_booking_notice | INTEGER | NOT NULL DEFAULT 0 (minutes) |

### Locations menu (`event_types.locations` JSON)
Array of entries; `type` is one of `integrations:daily | inPerson | userPhone`,
everything else passes through (`label`, `address`, `phone`, `displayPhone`,
`url`, ...). A `url` on an `integrations:daily` entry is a **pre-configured
permanent room** — bookings use it verbatim. Malformed JSON fails loudly
(`InvalidJsonColumnError`), it is never silently treated as empty.

### `event_type_hosts`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| event_type_id | INTEGER | NOT NULL → event_types.id (indexed; UNIQUE with host_user_id) |
| host_user_id | INTEGER | NOT NULL → users.id |
| priority | INTEGER | NOT NULL DEFAULT 0 (lower = round-robin tie-break preferred) |

Every event type has at least one row here, including `individual` types
(exactly one row).

### `bookings`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| uid | TEXT | NOT NULL UNIQUE — the **public** booking id |
| event_type_id | INTEGER | NOT NULL → event_types.id |
| host_user_id | INTEGER | NOT NULL → users.id (primary/organizer host) |
| start_time | TEXT | NOT NULL, ISO 8601 UTC |
| end_time | TEXT | NOT NULL, ISO 8601 UTC |
| buffer_before | INTEGER | NOT NULL DEFAULT 0 (snapshot at booking time) |
| buffer_after | INTEGER | NOT NULL DEFAULT 0 (snapshot at booking time) |
| status | TEXT | NOT NULL DEFAULT 'accepted'; enum: `pending` \| `accepted` \| `cancelled` \| `rejected` |
| cancelled_at | TEXT | ISO 8601 UTC; NULL until cancelled |
| idempotency_key | TEXT | NOT NULL UNIQUE — caller-supplied dedup key |
| location | TEXT | NULL-able; JSON of the CHOSEN location (not the menu) |

Chosen-location JSON: same shape as a menu entry; for Daily bookings carries
`url` (the room URL) and, **only for rooms minted per-booking**, a
`dailyRoomName` marker (teardown provenance).

### `host_occupancy_ticks`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| host_user_id | INTEGER | NOT NULL → users.id |
| tick | INTEGER | NOT NULL — `floor(utcMillis / 60_000)`; UNIQUE (host_user_id, tick) |
| booking_id | INTEGER | NOT NULL → bookings.id (indexed) |

One row per host per occupied UTC minute; the unique index is the concurrency
backstop. Internal — clients never write these.

### `booking_hosts`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| booking_id | INTEGER | NOT NULL → bookings.id; UNIQUE with host_user_id |
| host_user_id | INTEGER | NOT NULL → users.id |

Secondary hosts for `collective` bookings only.

### `attendees`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| booking_id | INTEGER | NOT NULL → bookings.id |
| email | TEXT | NOT NULL |
| name | TEXT | NULL |
| timezone | TEXT | NULL |
| phone | TEXT | NULL |

### `credentials`
| column | type | constraints |
|---|---|---|
| id | INTEGER | PK autoincrement |
| user_id | INTEGER | NOT NULL → users.id |
| type | TEXT | NOT NULL (e.g. `google_calendar`, `office365_calendar`) |
| encrypted_token | TEXT | NOT NULL (AES-256-GCM envelope `v1:iv:tag:ciphertext`; key = `TOKEN_ENCRYPTION_KEY`) |

**Indexes:** `schedules_user_unique`, `availability_schedule_idx`,
`event_type_owner_slug_unique`, `event_type_host_unique`,
`event_type_hosts_event_type_idx`, `bookings_host_time_idx`
(host_user_id, start_time, end_time), `host_occupancy_tick_unique`,
`host_occupancy_ticks_booking_idx`, `booking_host_unique`.

---

## 2. Operations (parameters + returns)

### 2.1 Create booking — `createBookingHandler(db, rawInput)`

**Input** (Zod-validated; unknown extra fields rejected at the handler boundary
for scalar fields, location passes through extras):

```jsonc
{
  "eventTypeId": 1,                        // integer, required
  "slotStartUtc": "2027-06-01T10:00:00Z",  // ISO 8601 WITH offset info, required
  "slotEndUtc":   "2027-06-01T11:00:00Z",  // ISO 8601 WITH offset info, required
  "location": { "type": "integrations:daily" }, // required; type enum above
  "attendee": {                            // required
    "email": "guest@example.com",          // required, email format
    "name": "Guest Name",                  // optional
    "timezone": "America/New_York",        // optional
    "phone": "+15555550123"                // optional (used for userPhone + SMS text)
  },
  "idempotencyKey": "your-opaque-unique-key" // required, min 1 char, UNIQUE per booking
}
```

Rules enforced at commit time: slot must lie inside working hours for **every**
attending host, respect `min_booking_notice`, land **exactly on the slot grid**
(window start + k × slot_interval), and not overlap any booking whose own
snapshotted buffers (`[start − bufferBefore, end + bufferAfter]`) touch the
slot. `slotEndUtc − slotStartUtc` must equal `length_minutes`.

**Output** (`BookingResult`):

```jsonc
{
  "uid": "…",                       // public booking id — store this
  "eventTypeId": 1,
  "hostUserId": 7,                  // primary/organizer host
  "attendingHostUserIds": [7],      // all hosts; collective lists everyone
  "startUtc": "2027-06-01T10:00:00.000Z",
  "endUtc": "2027-06-01T11:00:00.000Z",
  "status": "accepted",
  "replay": false,                  // true when an idempotency-key match returned an existing booking
  "location": {                     // the CHOSEN location
    "type": "integrations:daily",
    "label": "Video (Daily.co)",
    "url": "https://<team>.daily.co/<uid>", // present for Daily (permanent or minted)
    "dailyRoomName": "<uid>"        // only for minted rooms
  },
  "attendee": { "email": "…", "name": null, "phone": null }
}
```

**Idempotency:** submitting the same `idempotencyKey` never double-books — the
first stored booking is returned with `replay: true`.

**Errors → HTTP status** (`mapErrorToHttp`, the contract for the HTTP layer):

| error | status | meaning |
|---|---|---|
| `SlotConflictError` | 409 | slot taken, off-grid, out of hours, or inside min-notice |
| `LocationNotOfferedError` | 400 | requested location type not in the event type's menu |
| Zod validation failure | 400 | malformed input (message lists offending paths) |
| anything else | 500 | generic "Internal server error" — internals never leak |

Concurrency: two requests racing for the same slot → one 409. Internal
`SQLITE_BUSY` retries (up to 16, backoff) are handled inside the handler.

### 2.2 Cancel booking — `cancelBookingHandler(db, rawInput)`

**Input:** `{ "uid": "…" }` **or** `{ "idempotencyKey": "…" }` (at least one;
both allowed). Unknown booking → `BookingNotFoundError` → **404**. Cancelling
an already-cancelled booking returns it with `replay: true` (idempotent, 200).

**Output:** same `BookingResult` shape with `status: "cancelled"` and
`cancelled_at` stamped. Minted Daily rooms are deleted best-effort; ticks and
secondary-host rows are pruned in the same transaction, so the slot frees
atomically.

### 2.3 Availability — `computeMultiHostAvailability(repo, params)`

Query-time slot search (what a booking widget should call before create):

```jsonc
{
  "eventTypeId": 1,                  // required
  "hostUserIds": [7],                // candidates (handler layer resolves these from event_type_hosts)
  "schedulingType": "round_robin",   // "individual" | "round_robin" | "collective"
  "rangeStartUtc": "2027-06-01T00:00:00Z",
  "rangeEndUtc":   "2027-06-08T00:00:00Z",
  "now": "2026-08-28T12:00:00Z"      // optional; defaults to actual now (drives min-notice)
}
```

**Output:** array of `OfferedSlot` — `{ startUtc, endUtc, schedulingType,
attendingHostUserIds? }` (`attendingHostUserIds` only for `collective`; for
`round_robin` the listed host is a **preview** — the real host is assigned
atomically inside the booking transaction).

DST note: ranges are walked day-by-day in each schedule's local timezone;
spring-forward/fall-back are handled (missing wall-clock times produce no
slots, duplicated times resolve to first occurrence).

### 2.4 Reschedule booking — `rescheduleBookingHandler(db, uid, rawInput)`

Moves an existing accepted booking to a new slot **in place** (same `uid`, same
`eventTypeId` — the event type never changes). The request reuses the creation
flow's validation against the new slot; the old slot is freed atomically.

**Input** (Zod-validated; `uid` is the URL param, body carries the new slot):

```jsonc
{
  "slotStartUtc": "2027-06-01T14:00:00Z", // ISO 8601 WITH offset info, required
  "slotEndUtc":   "2027-06-01T14:30:00Z", // ISO 8601 WITH offset info, required
  "idempotencyKey": "your-reschedule-key",  // required, UNIQUE per reschedule attempt
  "reason": "host proposed new time"        // optional, max 2000 chars, not persisted as a booking column in v1
}
```

Rules enforced at commit time (same as create, against the **new** slot):
- `eventTypeId` is immutable — reschedule stays on the original event type.
- `slotEnd − slotStart` must equal `eventTypes.length_minutes`.
- Slot must lie inside working hours for **every** attending host, respect `min_booking_notice`, and land **exactly on the slot grid** (window start + k × slot_interval) — checked by re-running the availability engine's DST-safe day-walk for each host over a ±48 h window, with the booking's own current interval excluded so its old footprint does not block the move.
- No other active booking's snapshotted buffered interval ` [start − bufferBefore, end + bufferAfter]` may overlap the new slot — checked in SQL via `bufferedOverlapExists` excluding the rescheduled booking's own row.
- Concurrency backstop is the same `host_occupancy_ticks` unique index: old ticks are pruned and new ticks are inserted in the same transaction as the `bookings` row update; a losing tick insert surfaces as `SlotConflictError` → **409**, exactly like a fresh booking. `SQLITE_BUSY` retries (16, backoff) are handled inside the handler.
- Buffers are **re-snapshotted** from the live `event_types` row onto `bookings.buffer_before/after` at reschedule time, so a later-changed event-type buffer setting applies to the new footprint.
- Cancelled/rejected bookings cannot be rescheduled → `SlotConflictError` → **409**.
- Unknown `uid` → `BookingNotFoundError` → **404**.
- Auth scoping (HTTP layer): admin (`API_SECRET`) may reschedule any booking; a JWT caller may reschedule only bookings where they are the `host_user_id`, a secondary `booking_hosts` host (collective), or the `event_types.owner_user_id` — otherwise **403**. Idempotency keys are global (`reschedule_idempotency.idempotency_key` UNIQUE); a replay with the same key returns the mapped booking with `replay: true` even if the `uid` param differs.

**Output:** same `BookingResult` shape as create/cancel, with updated `startUtc`/`endUtc` (and re-snapshotted `buffer_*` reflected in the occupancy footprint). `replay: true` on idempotent replay, `replay: false` otherwise. The `uid` never changes, so a Room read-cache client can update its row by `uid`.

**Idempotency:** `reschedule_idempotency` stores one row per `idempotencyKey` (`booking_id`, `new_start_time`, `new_end_time`, `created_at`). A second POST with the same `uid` + same key returns the current booking with `replay: true`; the write transaction is not re-applied. A no-op reschedule where the booking is already at the target slot still records the key and returns `replay: false` on first call, `replay: true` on retry.

**Location / Daily rooms:** v1 does not mint a new Daily room on reschedule; `bookings.location` is unchanged (the original chosen location/URL stays). A follow-up may re-mint when the location is `integrations:daily` and the slot moves (requires `nbf`/`exp` rewrite + teardown of the old minted room).

**Push:** a successful reschedule fires `booking.rescheduled` through the same `waitUntil` + `bookingEventPush` path as create/cancel/paid (soft-fail, token-clear on 404/403/410). See §4.4.

---

## 3. How agents / clients can talk to this backend

### 3.1 Direct HTTPS to the DB (Turso HTTP API) — **read-only use only**
The database is reachable over plain HTTPS: `POST
https://<instance>.aws-us-west-2.turso.io/v2/pipeline` with
`Authorization: Bearer $TURSO_AUTH_TOKEN` and a JSON body of SQL statements
(see AGENTS.md for a worked example). This is fine for agents that only
**read** (e.g. listing event types). It is **not** a safe write path: raw SQL
writes bypass the slot-grid, min-notice, buffer-expansion, and tick-index
logic that makes double-booking impossible. Writes must go through the
handlers (HTTP layer or MCP).

### 3.2 MCP server — the safe agent path (recommended)
Expose each handler as an MCP tool so agents get booking logic for free:

| tool | wraps |
|---|---|
| `list_event_types` | SELECT over `event_types` + `event_type_hosts` |
| `check_availability` | `computeMultiHostAvailability` |
| `create_booking` | `createBookingHandler` |
| `cancel_booking` | `cancelBookingHandler` |

The server process holds `LIBSQL_URL`/`TURSO_AUTH_TOKEN` in its own
environment (agents never see credentials — they see tools). Locally agents
connect over stdio; remotely the same server can be exposed over MCP
streamable HTTP behind a bearer token, which is where the "user secrets"
gate belongs. Errors map through `mapErrorToHttp`, so agents receive
409/404/400 semantics as tool errors.

### 3.3 Frontend HTTP layer (when built)
The handler layer + `mapErrorToHttp` were designed for a thin HTTP wrapper:
`GET /availability`, `POST /bookings`, `POST /bookings/cancel` (or
`DELETE /bookings/:uid`), `GET /event-types`. Auth middleware issues/validates
per-user secrets; handlers stay unchanged.

---

## 4. HTTP surface (as of 2026-08-30)

The Upcoming Android client (separate repo) talks to this Worker over HTTPS.
**Official base URL: `https://api.getupcoming.app`** (Workers custom domain on
the `getupcoming.app` zone; the `*.workers.dev` deployment hostname remains as
a secondary endpoint). Share URLs and single-use links are minted against
`https://getupcoming.app`.

### 4.1 Auth

- **JWT (per-user):** `Authorization: Bearer <accessToken>` → `authUserId`;
  owner-scoped. Minted by `/auth/signup` `/auth/login`, rotated by
  `/auth/refresh` (HS256 access ~1h + opaque hashed refresh 30d).
- **Shared secret (admin):** `Authorization: Bearer $API_SECRET` →
  `authIsAdmin`; sees all owners' data. Server-side/operator use only — it
  must never ship in a client binary.
- **Open paths:** `/health`, `/auth/*`.

### 4.2 Route table

| Route | Method | Purpose |
|---|---|---|
| `/health` | GET | liveness, exempt from rate limiting |
| `/auth/signup` `/auth/login` `/auth/refresh` `/auth/logout` | POST | JWT pair lifecycle |
| `/event-types` | GET | list (JWT: active + own inactive; `?activeOnly=true`; admin: all) |
| `/event-types` | POST | create (owner = JWT user; host rows required) |
| `/event-types/:id` | PATCH | update (owner-scoped) |
| `/event-types/:id` | DELETE | soft-delete (`isActive: false`, owner-scoped) |
| `/me`, `/me/schedule` | GET/PATCH | profile + metadata (incl. `fcmToken`) + timezone lockstep |
| `/me/credentials[/:type]` | GET/PUT/DELETE | BYO keys (AES-256-GCM at rest, masked hints out) |
| `/bookings`, `/bookings/:uid` | GET | list/detail (JWT: own — primary host, co-host, or attendee matching the caller's own user email; admin secret: all). Read scoping realized 2026-08-30 — see below |
| `/availability` | GET | multi-host slot search |
| `/bookings` | POST | create (idempotent, atomic, optional `singleUseToken`) |
| `/bookings/cancel` | POST | cancel + tick/room pruning in one tx |
| `/bookings/:uid/reschedule` | POST | reschedule to new slot (idempotent, atomic tick swap, re-validates via availability engine + occupancy index; `booking.rescheduled` push) |
| `/single-use-links[/:id]` | POST/GET/DELETE | one-time link create/list/revoke (owner-scoped) |
| `/payments/create-intent` `/payments/mark-paid` | POST | Stripe PI; `paid` flips only after PI verification |
| `/push-reminders` | POST | admin-only manual reminder-sweep trigger |

**Event-type mutation errors** (POST/PATCH): malformed *body* JSON →
`400 "body must be valid JSON"`; malformed `locations` field →
`400 "locations is not valid JSON"`; validation issues include full Zod
messages in the `detail` array. Duplicate `(owner, slug)` → 409.

**Booking read scoping** (2026-08-30 — realizes the "JWT: own; admin: all"
contract on `GET /bookings` and `GET /bookings/:uid`):

- A **JWT caller** sees a booking only when they are the primary host
  (`bookings.host_user_id`), a co-host (`booking_hosts.host_user_id`), or the
  attendee whose email matches their own user row's email (`attendees` are
  identified by email — there is no attendee userId column). A JWT caller is
  scoped even if they also carry admin; the legacy shared **admin secret**
  (no JWT) surface stays unscoped for ops, exactly like `/me` and event-type
  mutation scoping.
- Detail reads are **404** (not 403) when not visible — the existence of other
  users' booking uids is not leaked. Message stays `"booking not found"`.
- List reads AND a three-way own-predicate into the query; `from`/`to`/
  `activeOnly` keep working as narrowers on top. A `hostUserId` query param
  naming a user **other than the caller** is **403** `"forbidden: cannot
  access another user"`; naming the caller it just narrows their own set;
  non-integer/non-positive values are **400** for JWT callers.
- A JWT whose user row no longer exists is **404** `"user no longer exists"`
  (uniform with `/me` target-user resolution).
- Internal server-side readers (the FCM reminder sweep, lifecycle push
  fan-out) hit the database directly and never go through these HTTP routes —
  scoping is an HTTP read-surface fix only.

### 4.3 Rate limiting (2026-08-30)

Two layers:

1. **Cloudflare WAF rule (authoritative, global per IP per colo):** block
   after **15 requests / 10s** on `api.getupcoming.app` (10s mitigation).
   Returns Cloudflare's 429 block page.
2. **Worker middleware (per-endpoint tiers, per-isolate best-effort):**
   `POST /auth/*` 10/min · `GET /availability` 50/min · `POST /bookings*`
   20/min · `POST /payments/*` 20/min · default 100/min. Returns
   `429 {"error":"rate limit exceeded"}` with a `Retry-After` header (seconds).

In-isolate counters under-approximate global limits by design (safe
direction); true per-endpoint global enforcement would need a Durable Object
limiter (post-launch upgrade if needed).

### 4.4 Push (FCM, 2026-08-30)

- **Registration:** client stores its FCM token via `PATCH /me` →
  `metadata.fcmToken` (one token per user for v1; overwrite on refresh).
  Requires this contract deployed first — `UserMetadata` is strict.
- **Lifecycle pushes** (to `bookings.host_user_id`, via `waitUntil`,
  soft-fail): booking **created / cancelled / paid / rescheduled**.
- **Reminder sweep:** every 15 min (cron) + `POST /push-reminders` (admin).
  For each accepted booking, each configured offset in
  `metadata.prefs.reminderOffsets` (default `[10]`) whose fire time
  (start − offset) lands in the sweep window fires once. Missing max-horizon
  math: reminders up to 7 days ahead are covered.
- **Payload:**
  ```jsonc
  {
    "notification": { "title": "New booking", "body": "Intro — Mon, Jun 1 at 1:00 PM" },
    "data": { "bookingUid": "…", "action": "booking.created|booking.cancelled|booking.paid|booking.rescheduled|booking.reminder", "offsetMin": "10" }
  }
  ```
  (notification title/body present for lifecycle + reminder; `offsetMin` only
  on reminders.)
- **Config:** `FCM_SERVICE_ACCOUNT` secret (service-account key JSON with
  `project_id`, `client_email`, `private_key`). Unset = push disabled, cron
  no-ops. Unregistered/invalid tokens (404/403/410) are cleared from metadata
  automatically.
