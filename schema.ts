import { sqliteTable, integer, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

// ============================================================================
// Core identity + availability
// ============================================================================

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  timezone: text("timezone").notNull().default("UTC"),
  metadata: text("metadata").notNull().default("{}"), // JSON
  // App-facing profile fields (additive, 2026-08-28): clients render these;
  // the scheduling engine never reads them.
  displayName: text("display_name").notNull().default(""),
  avatarUrl: text("avatar_url").notNull().default(""),
});

export const schedules = sqliteTable(
  "schedules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(), // IANA name — source of truth for computeAvailability
  },
  (t) => ({
    // getSchedule(userId) returns this single row. Multiple schedules per user
    // would need event_types.schedule_id (or a default flag) first.
    userUnique: uniqueIndex("schedules_user_unique").on(t.userId),
  })
);

export const availability = sqliteTable(
  "availability",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => schedules.id),
    dayOfWeek: integer("day_of_week"), // 0 (Sun) - 6 (Sat); null if date-specific
    dateOverride: text("date_override"), // ISO date 'YYYY-MM-DD'; null if recurring
    startTime: text("start_time").notNull(), // 'HH:MM' local wall clock
    endTime: text("end_time").notNull(),
  },
  (t) => ({ scheduleIdx: index("availability_schedule_idx").on(t.scheduleId) })
);

// ============================================================================
// Event types + hosts
// ============================================================================

export const eventTypes = sqliteTable(
  "event_types",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerUserId: integer("owner_user_id") // creator/manager of record, NOT necessarily a host
      .notNull()
      .references(() => users.id),
    slug: text("slug").notNull(),
    lengthMinutes: integer("length_minutes").notNull(),
    slotIntervalMinutes: integer("slot_interval_minutes"), // null -> defaults to lengthMinutes in the engine
    bufferBefore: integer("buffer_before").notNull().default(0),
    bufferAfter: integer("buffer_after").notNull().default(0),
    schedulingType: text("scheduling_type", { enum: ["individual", "round_robin", "collective"] })
      .notNull()
      .default("individual"),
    locations: text("locations").notNull().default("[]"), // JSON array
    minBookingNotice: integer("min_booking_notice").notNull().default(0), // minutes
    // App-facing presentation + paid-booking fields (additive, 2026-08-28).
    // Availability/booking math ignores all of these.
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    priceInCents: integer("price_in_cents").notNull().default(0), // 0 = free
    currency: text("currency").notNull().default("usd"),
    colorHex: text("color_hex").notNull().default("#CC785C"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => ({ ownerSlugUnique: uniqueIndex("event_type_owner_slug_unique").on(t.ownerUserId, t.slug) })
);

// The bridge between single-host and team-based scheduling. EVERY event type
// gets rows here, including individual ones (exactly one row) — this keeps
// loadEventType() uniform instead of branching on scheduling_type to decide
// where hosts come from. `priority` gives round-robin a stable tie-break
// ordering independent of the fairness policy in multi-host-routing.ts.
export const eventTypeHosts = sqliteTable(
  "event_type_hosts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventTypeId: integer("event_type_id")
      .notNull()
      .references(() => eventTypes.id),
    hostUserId: integer("host_user_id")
      .notNull()
      .references(() => users.id),
    priority: integer("priority").notNull().default(0), // lower = preferred tie-break
  },
  (t) => ({
    eventTypeHostUnique: uniqueIndex("event_type_host_unique").on(t.eventTypeId, t.hostUserId),
    eventTypeIdx: index("event_type_hosts_event_type_idx").on(t.eventTypeId),
  })
);

// ============================================================================
// Bookings
// ============================================================================

export const bookings = sqliteTable(
  "bookings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uid: text("uid").notNull().unique(), // public-facing id
    eventTypeId: integer("event_type_id")
      .notNull()
      .references(() => eventTypes.id),
    hostUserId: integer("host_user_id") // primary/organizer host
      .notNull()
      .references(() => users.id),
    startTime: text("start_time").notNull(), // ISO 8601 UTC instant
    endTime: text("end_time").notNull(),
    // Denormalized snapshot of the buffer that applied AT BOOKING TIME, so a
    // later edit to the event type's buffer settings can't silently change
    // how a past booking's conflict footprint is interpreted.
    bufferBefore: integer("buffer_before").notNull().default(0),
    bufferAfter: integer("buffer_after").notNull().default(0),
    status: text("status", { enum: ["pending", "accepted", "cancelled", "rejected"] })
      .notNull()
      .default("accepted"),
    // ISO 8601 UTC instant stamped by cancelBookingHandler; null until cancelled.
    cancelledAt: text("cancelled_at"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    // JSON of the CHOSEN location option (with `url` when integrations:daily),
    // not the whole event-type menu.
    location: text("location"),
    // Payment + audit fields (additive, 2026-08-28). `paid` flips only after
    // the HTTP layer verifies the PaymentIntent succeeded; `created_at` is the
    // insert-time ISO instant (set by the handler layer, nullable for rows
    // written before the column existed).
    paid: integer("paid", { mode: "boolean" }).notNull().default(false),
    paymentIntentId: text("payment_intent_id"),
    createdAt: text("created_at"),
  },
  (t) => ({
    hostTimeIdx: index("bookings_host_time_idx").on(t.hostUserId, t.startTime, t.endTime),
  })
);

// One row per host per occupied UTC minute. Unique (host, tick) is SQLite's
// stand-in for an exclusion constraint on overlapping intervals.
export const hostOccupancyTicks = sqliteTable(
  "host_occupancy_ticks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hostUserId: integer("host_user_id")
      .notNull()
      .references(() => users.id),
    tick: integer("tick").notNull(), // floor(utcMillis / 60_000)
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookings.id),
  },
  (t) => ({
    hostTickUnique: uniqueIndex("host_occupancy_tick_unique").on(t.hostUserId, t.tick),
    bookingIdx: index("host_occupancy_ticks_booking_idx").on(t.bookingId),
  })
);

// Secondary hosts for collective bookings — the organizer lives on
// bookings.host_user_id, everyone else attaches here.
export const bookingHosts = sqliteTable(
  "booking_hosts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookings.id),
    hostUserId: integer("host_user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => ({ uniquePair: uniqueIndex("booking_host_unique").on(t.bookingId, t.hostUserId) })
);

export const attendees = sqliteTable("attendees", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bookingId: integer("booking_id")
    .notNull()
    .references(() => bookings.id),
  email: text("email").notNull(),
  name: text("name"),
  timezone: text("timezone"),
  phone: text("phone"),
  notes: text("notes"), // free-text note from the attendee (additive, 2026-08-28)
});

export const credentials = sqliteTable("credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  type: text("type").notNull(), // 'google_calendar' | 'office365_calendar' | ...
  encryptedToken: text("encrypted_token").notNull(),
});
