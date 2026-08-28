import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { createBookingHandler } from "./create-booking-handler";
import { availability, eventTypeHosts, eventTypes, schedules, users } from "./schema";
import * as schema from "./schema";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;

function isLibsqlInstance(value: string | undefined): value is string {
  if (!value) return false;
  return value.startsWith("http://") || value.startsWith("https://") || value.startsWith("libsql://");
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
    for (const required of [
      "users",
      "schedules",
      "availability",
      "event_types",
      "event_type_hosts",
      "bookings",
      "booking_hosts",
      "attendees",
      "host_occupancy_ticks",
      "host_mutexes",
      "credentials",
    ]) {
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
    client.close();
  }
});
