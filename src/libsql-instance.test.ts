import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Table, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { createBookingHandler, SlotConflictError } from "./create-booking-handler";
import { availability, eventTypeHosts, eventTypes, schedules, users } from "./schema";
import * as schema from "./schema";
import { openTestDb } from "./test-db";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;

function isLibsqlInstance(value: string | undefined): value is string {
  if (!value) return false;
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("libsql://");
}

function expectedTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (value instanceof Table) names.push(getTableName(value));
  }
  return names.sort();
}

// Offline: the test harness must apply the exact same DDL production applies
// (schema.sql), so every table and named index in schema.ts exists in a
// throwaway test db. This is the always-on half of the drift guard; the live
// instance is checked by `npm run drift:check` (scheduled CI job).
test("openTestDb applies every table and named index from schema.ts", async () => {
  const { db, close } = await openTestDb();
  try {
    const tables = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    );
    const tableNames = new Set(tables.rows.map((r) => String(r.name)));
    for (const required of expectedTableNames()) {
      assert.equal(tableNames.has(required), true, `missing table ${required}`);
    }

    const indexes = await db.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    );
    const indexNames = new Set(indexes.rows.map((r) => String(r.name)));
    for (const value of Object.values(schema)) {
      if (!(value instanceof Table)) continue;
      for (const idx of getTableConfig(value).indexes) {
        const name = idx.config.name;
        if (!name || name.startsWith("sqlite_")) continue;
        assert.equal(indexNames.has(name), true, `missing index ${name}`);
      }
    }
  } finally {
    close();
  }
});

// The hand-written test DDL used to omit event_type_owner_slug_unique, so
// handler tests could seed duplicate (owner, slug) pairs production forbids.
// This test pins the constraint's presence through the harness.
test("test harness enforces event_type_owner_slug_unique", async () => {
  const { db, close } = await openTestDb();
  try {
    await db.insert(users).values({ email: "u@x.test", username: "u", timezone: "UTC" });
    const [user] = await db.select().from(users);
    await db.insert(eventTypes).values({ ownerUserId: user.id, slug: "dup", lengthMinutes: 30 });
    await assert.rejects(
      db.insert(eventTypes).values({ ownerUserId: user.id, slug: "dup", lengthMinutes: 30 })
    );
  } finally {
    close();
  }
});

// Removes every fixture row a live test inserted for its synthetic user, in
// FK-safe dependency order. Used by the live tests' finally blocks so repeated
// runs do not accumulate rows in the remote database.
async function deleteLiveFixtures(client: Client, userId: number): Promise<void> {
  const bookings = await client.execute({
    sql: "SELECT id FROM bookings WHERE host_user_id = ?",
    args: [userId],
  });
  for (const row of bookings.rows) {
    const bookingId = Number(row.id);
    await client.execute({ sql: "DELETE FROM attendees WHERE booking_id = ?", args: [bookingId] });
    await client.execute({
      sql: "DELETE FROM host_occupancy_ticks WHERE booking_id = ?",
      args: [bookingId],
    });
    await client.execute({ sql: "DELETE FROM booking_hosts WHERE booking_id = ?", args: [bookingId] });
    await client.execute({ sql: "DELETE FROM bookings WHERE id = ?", args: [bookingId] });
  }

  const eventTypes_ = await client.execute({
    sql: "SELECT id FROM event_types WHERE owner_user_id = ?",
    args: [userId],
  });
  for (const row of eventTypes_.rows) {
    const eventTypeId = Number(row.id);
    await client.execute({
      sql: "DELETE FROM event_type_hosts WHERE event_type_id = ?",
      args: [eventTypeId],
    });
    await client.execute({ sql: "DELETE FROM event_types WHERE id = ?", args: [eventTypeId] });
  }

  const scheds = await client.execute({
    sql: "SELECT id FROM schedules WHERE user_id = ?",
    args: [userId],
  });
  for (const row of scheds.rows) {
    const scheduleId = Number(row.id);
    await client.execute({ sql: "DELETE FROM availability WHERE schedule_id = ?", args: [scheduleId] });
    await client.execute({ sql: "DELETE FROM schedules WHERE id = ?", args: [scheduleId] });
  }

  await client.execute({ sql: "DELETE FROM users WHERE id = ?", args: [userId] });
}

test("LibSQL/Turso instance has the applied schema", async (t) => {
  if (!isLibsqlInstance(url)) {
    t.skip("Set LIBSQL_URL or TURSO_DATABASE_URL to a http(s)/libsql instance (not a SQLite file)");
    return;
  }

  const client = createClient(
    process.env.TURSO_AUTH_TOKEN ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url }
  );
  try {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const names = tables.rows.map((r) => String(r.name));
    for (const required of expectedTableNames()) {
      assert.equal(names.includes(required), true, `missing table ${required}`);
    }

    const idx = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'host_occupancy_tick_unique'"
    );
    assert.equal(idx.rows.length, 1);
  } finally {
    client.close();
  }
});

test("createBookingHandler writes through the LibSQL instance", async (t) => {
  if (!isLibsqlInstance(url)) {
    t.skip("Set LIBSQL_URL or TURSO_DATABASE_URL to a http(s)/libsql instance (not a SQLite file)");
    return;
  }

  const client = createClient(
    process.env.TURSO_AUTH_TOKEN ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url }
  );
  const db = drizzle(client, { schema });
  const suffix = `${Date.now()}`;

  try {
    await db.insert(users).values({
      email: `live-${suffix}@x.test`,
      username: `live-${suffix}`,
      timezone: "UTC",
    });
    const userRows = await client.execute({
      sql: "SELECT id FROM users WHERE username = ?",
      args: [`live-${suffix}`],
    });
    const userId = Number(userRows.rows[0]!.id);

    await db.insert(schedules).values({ userId, name: "default", timezone: "UTC" });
    const sched = await client.execute({
      sql: "SELECT id FROM schedules WHERE user_id = ?",
      args: [userId],
    });
    const scheduleId = Number(sched.rows[0]!.id);

    await db.insert(availability).values({
      scheduleId,
      dayOfWeek: null,
      dateOverride: "2027-06-01",
      startTime: "00:00",
      endTime: "23:59",
    });

    await db.insert(eventTypes).values({
      ownerUserId: userId,
      slug: `live-${suffix}`,
      lengthMinutes: 60,
      slotIntervalMinutes: 30,
      schedulingType: "individual",
      locations: JSON.stringify([{ type: "inPerson", label: "In person" }]),
    });
    const et = await client.execute({
      sql: "SELECT id FROM event_types WHERE slug = ?",
      args: [`live-${suffix}`],
    });
    const eventTypeId = Number(et.rows[0]!.id);
    await db.insert(eventTypeHosts).values({ eventTypeId, hostUserId: userId, priority: 0 });

    const result = await createBookingHandler(db, {
      eventTypeId,
      slotStartUtc: "2027-06-01T10:00:00.000Z",
      slotEndUtc: "2027-06-01T11:00:00.000Z",
      location: { type: "inPerson" },
      attendee: { email: `guest-${suffix}@x.test` },
      idempotencyKey: `live-${suffix}`,
    });

    assert.equal(result.status, "accepted");
    assert.equal(result.hostUserId, userId);

    const ticks = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM host_occupancy_ticks WHERE host_user_id = ?",
      args: [userId],
    });
    assert.equal(Number(ticks.rows[0]!.n) > 0, true);
  } finally {
    try {
      const userRows = await client.execute({
        sql: "SELECT id FROM users WHERE username = ?",
        args: [`live-${suffix}`],
      });
      if (userRows.rows.length > 0) {
        await deleteLiveFixtures(client, Number(userRows.rows[0]!.id));
      }
    } catch (error) {
      console.warn("live fixture cleanup failed:", error);
    }
    client.close();
  }
});

// Plan v2 Phase 2: contention must be proven against the REAL Turso Cloud
// topology (single-primary HTTP), not just a local file/sqld. Two independent
// clients race the same slot with different idempotency keys; exactly one
// booking may materialize and the loser must get SlotConflictError.
test("two clients contending for one slot on live Turso: one booking, one 409", async (t) => {
  if (!isLibsqlInstance(url)) {
    t.skip("Set LIBSQL_URL or TURSO_DATABASE_URL to a http(s)/libsql instance (not a SQLite file)");
    return;
  }

  const clientOpts = () =>
    process.env.TURSO_AUTH_TOKEN ? { url, authToken: process.env.TURSO_AUTH_TOKEN } : { url };
  const client = createClient(clientOpts());
  const client2 = createClient(clientOpts());
  const db = drizzle(client, { schema });
  const db2 = drizzle(client2, { schema });
  const suffix = `cc-${Date.now()}`;

  try {
    await db.insert(users).values({
      email: `live-${suffix}@x.test`,
      username: `live-${suffix}`,
      timezone: "UTC",
    });
    const userRows = await client.execute({
      sql: "SELECT id FROM users WHERE username = ?",
      args: [`live-${suffix}`],
    });
    const userId = Number(userRows.rows[0]!.id);

    await db.insert(schedules).values({ userId, name: "default", timezone: "UTC" });
    const sched = await client.execute({
      sql: "SELECT id FROM schedules WHERE user_id = ?",
      args: [userId],
    });
    const scheduleId = Number(sched.rows[0]!.id);
    await db.insert(availability).values({
      scheduleId,
      dayOfWeek: null,
      dateOverride: "2027-06-01",
      startTime: "00:00",
      endTime: "23:59",
    });

    await db.insert(eventTypes).values({
      ownerUserId: userId,
      slug: `live-${suffix}`,
      lengthMinutes: 60,
      slotIntervalMinutes: 30,
      schedulingType: "individual",
      locations: JSON.stringify([{ type: "inPerson", label: "In person" }]),
    });
    const et = await client.execute({
      sql: "SELECT id FROM event_types WHERE slug = ?",
      args: [`live-${suffix}`],
    });
    const eventTypeId = Number(et.rows[0]!.id);
    await db.insert(eventTypeHosts).values({ eventTypeId, hostUserId: userId, priority: 0 });

    const start = "2027-06-01T10:00:00.000Z";
    const end = "2027-06-01T11:00:00.000Z";
    const results = await Promise.allSettled([
      createBookingHandler(db, {
        eventTypeId,
        slotStartUtc: start,
        slotEndUtc: end,
        location: { type: "inPerson" },
        attendee: { email: `guest-a-${suffix}@x.test` },
        idempotencyKey: `live-${suffix}-a`,
      }),
      createBookingHandler(db2, {
        eventTypeId,
        slotStartUtc: start,
        slotEndUtc: end,
        location: { type: "inPerson" },
        attendee: { email: `guest-b-${suffix}@x.test` },
        idempotencyKey: `live-${suffix}-b`,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"));

    assert.equal(fulfilled.length, 1, `expected exactly one winner: ${reasons.join(" | ")}`);
    assert.equal(
      (rejected[0] as PromiseRejectedResult).reason instanceof SlotConflictError,
      true,
      `loser must be SlotConflictError, got: ${reasons.join(" | ")}`
    );

    // Invariants: exactly one booking row for this host/slot, and exactly the
    // expected tick set (60-minute slot, zero buffers -> 60 ticks).
    const bookingCount = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM bookings WHERE host_user_id = ? AND start_time = ?",
      args: [userId, start],
    });
    assert.equal(Number(bookingCount.rows[0]!.n), 1, "exactly one booking row must exist");
    const tickCount = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM host_occupancy_ticks WHERE host_user_id = ?",
      args: [userId],
    });
    assert.equal(Number(tickCount.rows[0]!.n), 60, "exactly 60 occupancy ticks must exist");
  } finally {
    try {
      const userRows = await client.execute({
        sql: "SELECT id FROM users WHERE username = ?",
        args: [`live-${suffix}`],
      });
      if (userRows.rows.length > 0) {
        await deleteLiveFixtures(client, Number(userRows.rows[0]!.id));
      }
    } catch (error) {
      console.warn("live fixture cleanup failed:", error);
    }
    client.close();
    client2.close();
  }
});
