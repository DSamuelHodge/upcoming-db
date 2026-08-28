import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import {
  BookingNotFoundError,
  CreateBookingInput,
  cancelBookingHandler,
  createBookingHandler,
  findOrphanedTicks,
  SlotConflictError,
} from "./create-booking-handler";
import { loadEventType } from "./event-types";
import { attendees, availability, eventTypeHosts, eventTypes, schedules, users } from "./schema";
import { openDb, openTestDb } from "./test-db";

const LOCATIONS_JSON = JSON.stringify([
  { type: "integrations:daily", label: "Video (Daily.co)" },
  { type: "inPerson", label: "In person — Brick House Blue, Hilliard", address: "[REDACTED_ADDRESS]" },
  { type: "userPhone", label: "Phone", phone: "+15555550100", displayPhone: "(555) 555-0100" },
]);

const base = {
  eventTypeId: 1,
  location: { type: "inPerson" } as const,
  attendee: { email: "a@example.com" },
  idempotencyKey: "k1",
};

test("CreateBookingInput accepts Z and +00:00 slot bounds", () => {
  const z = CreateBookingInput.parse({
    ...base,
    slotStartUtc: "2026-03-09T13:00:00.000Z",
    slotEndUtc: "2026-03-09T13:30:00.000Z",
  });
  const offset = CreateBookingInput.parse({
    ...base,
    slotStartUtc: "2026-03-09T13:00:00+00:00",
    slotEndUtc: "2026-03-09T13:30:00+00:00",
  });
  assert.equal(z.slotStartUtc.endsWith("Z"), true);
  assert.equal(offset.slotStartUtc.includes("+00:00"), true);
});

async function seedUsersAndHours(db: Awaited<ReturnType<typeof openTestDb>>["db"]) {
  await db.insert(users).values([
    { id: 1, email: "a@x.test", username: "a", timezone: "UTC" },
    { id: 2, email: "b@x.test", username: "b", timezone: "UTC" },
    { id: 3, email: "c@x.test", username: "c", timezone: "UTC" },
  ]);
  await db.insert(schedules).values([
    { id: 1, userId: 1, name: "A", timezone: "UTC" },
    { id: 2, userId: 2, name: "B", timezone: "UTC" },
    { id: 3, userId: 3, name: "C", timezone: "UTC" },
  ]);
  await db.insert(availability).values([
    { scheduleId: 1, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "00:00", endTime: "23:59" },
    { scheduleId: 2, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "00:00", endTime: "23:59" },
    { scheduleId: 3, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "00:00", endTime: "23:59" },
  ]);
}

test("hosts with the same priority sort by hostUserId", async () => {
  const { db, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await db.insert(eventTypes).values({
      id: 1,
      ownerUserId: 1,
      slug: "team",
      lengthMinutes: 60,
      slotIntervalMinutes: 30,
      schedulingType: "collective",
      locations: LOCATIONS_JSON,
    });
    await db.insert(eventTypeHosts).values([
      { eventTypeId: 1, hostUserId: 3, priority: 1 },
      { eventTypeId: 1, hostUserId: 2, priority: 1 },
    ]);
    const loaded = await loadEventType(db, 1);
    assert.deepEqual(loaded.hostUserIds, [2, 3]);
  } finally {
    close();
  }
});

async function seedIndividual(db: Awaited<ReturnType<typeof openTestDb>>["db"], opts?: { id?: number; hostUserId?: number; slug?: string }) {
  const id = opts?.id ?? 1;
  const hostUserId = opts?.hostUserId ?? 1;
  const slug = opts?.slug ?? `et-${id}`;
  await db.insert(eventTypes).values({
    id,
    ownerUserId: hostUserId,
    slug,
    lengthMinutes: 60,
    slotIntervalMinutes: 30,
    schedulingType: "individual",
    locations: LOCATIONS_JSON,
  });
  await db.insert(eventTypeHosts).values({ eventTypeId: id, hostUserId, priority: 0 });
}

function bookingInput(partial: Partial<typeof base> & { slotStartUtc: string; slotEndUtc: string; idempotencyKey: string; eventTypeId?: number; location?: { type: string } }) {
  return {
    eventTypeId: 1,
    location: { type: "inPerson" },
    attendee: { email: `${partial.idempotencyKey}@x.test` },
    ...partial,
  };
}

test("concurrent same primary same start: one succeeds, one 409", async () => {
  const opened = await openTestDb();
  try {
    await seedUsersAndHours(opened.db);
    await seedIndividual(opened.db);
    const { db: db2, client: client2 } = await openDb(opened.url);
    const start = "2027-06-01T10:00:00.000Z";
    const end = "2027-06-01T11:00:00.000Z";
    const results = await Promise.allSettled([
      createBookingHandler(opened.db, bookingInput({ slotStartUtc: start, slotEndUtc: end, idempotencyKey: "a" })),
      createBookingHandler(db2, bookingInput({ slotStartUtc: start, slotEndUtc: end, idempotencyKey: "b" })),
    ]);
    client2.close();
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    assert.equal(err instanceof SlotConflictError, true);
    assert.equal((err as SlotConflictError).statusCode, 409);

    // Invariants, not just outcomes: exactly one booking row and one tick set
    // must exist for this host regardless of which request won.
    const bookingCount = await opened.db.$client.execute(
      "SELECT COUNT(*) AS n FROM bookings WHERE host_user_id = 1 AND start_time = '2027-06-01T10:00:00.000Z'"
    );
    assert.equal(Number(bookingCount.rows[0]!.n), 1);
    const tickCount = await opened.db.$client.execute(
      "SELECT COUNT(*) AS n FROM host_occupancy_ticks WHERE host_user_id = 1"
    );
    assert.equal(Number(tickCount.rows[0]!.n), 60);
  } finally {
    opened.close();
  }
});

test("concurrent same primary overlapping different starts: one wins", async () => {
  const opened = await openTestDb();
  try {
    await seedUsersAndHours(opened.db);
    await seedIndividual(opened.db);
    const { db: db2, client: client2 } = await openDb(opened.url);
    const results = await Promise.allSettled([
      createBookingHandler(
        opened.db,
        bookingInput({ slotStartUtc: "2027-06-01T10:00:00.000Z", slotEndUtc: "2027-06-01T11:00:00.000Z", idempotencyKey: "a" })
      ),
      createBookingHandler(
        db2,
        bookingInput({ slotStartUtc: "2027-06-01T10:30:00.000Z", slotEndUtc: "2027-06-01T11:30:00.000Z", idempotencyKey: "b" })
      ),
    ]);
    client2.close();
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => r.status === "rejected" ? String(r.reason) : "ok")));
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason instanceof SlotConflictError, true);
  } finally {
    opened.close();
  }
});

test("collective holds the secondary so a concurrent individual cannot steal it", async () => {
  const opened = await openTestDb();
  try {
    await seedUsersAndHours(opened.db);
    await opened.db.insert(eventTypes).values({
      id: 1,
      ownerUserId: 1,
      slug: "collective",
      lengthMinutes: 60,
      slotIntervalMinutes: 30,
      schedulingType: "collective",
      locations: LOCATIONS_JSON,
    });
    await opened.db.insert(eventTypeHosts).values([
      { eventTypeId: 1, hostUserId: 1, priority: 0 },
      { eventTypeId: 1, hostUserId: 2, priority: 0 },
    ]);
    await seedIndividual(opened.db, { id: 2, hostUserId: 2, slug: "solo-b" });

    const { db: db2, client: client2 } = await openDb(opened.url);
    const start = "2027-06-01T10:00:00.000Z";
    const end = "2027-06-01T11:00:00.000Z";
    const results = await Promise.allSettled([
      createBookingHandler(
        opened.db,
        bookingInput({ eventTypeId: 1, slotStartUtc: start, slotEndUtc: end, idempotencyKey: "collective" })
      ),
      createBookingHandler(
        db2,
        bookingInput({ eventTypeId: 2, slotStartUtc: start, slotEndUtc: end, idempotencyKey: "solo" })
      ),
    ]);
    client2.close();
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason instanceof SlotConflictError, true);
  } finally {
    opened.close();
  }
});

test("distinct hosts and non-overlapping times both succeed", async () => {
  const opened = await openTestDb();
  try {
    await seedUsersAndHours(opened.db);
    await seedIndividual(opened.db, { id: 1, hostUserId: 1, slug: "solo-a" });
    await seedIndividual(opened.db, { id: 2, hostUserId: 2, slug: "solo-b" });
    const { db: db2, client: client2 } = await openDb(opened.url);
    const [a, b] = await Promise.all([
      createBookingHandler(
        opened.db,
        bookingInput({ eventTypeId: 1, slotStartUtc: "2027-06-01T10:00:00.000Z", slotEndUtc: "2027-06-01T11:00:00.000Z", idempotencyKey: "a" })
      ),
      createBookingHandler(
        db2,
        bookingInput({ eventTypeId: 2, slotStartUtc: "2027-06-01T12:00:00.000Z", slotEndUtc: "2027-06-01T13:00:00.000Z", idempotencyKey: "b" })
      ),
    ]);
    client2.close();
    assert.equal(a.hostUserId, 1);
    assert.equal(b.hostUserId, 2);
  } finally {
    opened.close();
  }
});

test("normal non-overlapping sequential bookings on one host succeed", async () => {
  const { db, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await seedIndividual(db);
    const first = await createBookingHandler(
      db,
      bookingInput({ slotStartUtc: "2027-06-01T10:00:00.000Z", slotEndUtc: "2027-06-01T11:00:00.000Z", idempotencyKey: "a" })
    );
    const second = await createBookingHandler(
      db,
      bookingInput({ slotStartUtc: "2027-06-01T11:00:00.000Z", slotEndUtc: "2027-06-01T12:00:00.000Z", idempotencyKey: "b" })
    );
    assert.equal(first.status, "accepted");
    assert.equal(second.status, "accepted");
    const rows = await db.select().from(attendees);
    assert.equal(rows.length, 2);
  } finally {
    close();
  }
});

test("cancel stamps cancelled_at, prunes ticks and secondary hosts, frees the slot", async () => {
  const { db, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await seedIndividual(db);
    const start = "2027-06-01T10:00:00.000Z";
    const end = "2027-06-01T11:00:00.000Z";
    const booked = await createBookingHandler(
      db,
      bookingInput({ slotStartUtc: start, slotEndUtc: end, idempotencyKey: "cancel-a" })
    );

    const ticksBefore = await db.$client.execute(
      "SELECT COUNT(*) AS n FROM host_occupancy_ticks WHERE host_user_id = 1"
    );
    assert.equal(Number(ticksBefore.rows[0]!.n), 60);

    const result = await cancelBookingHandler(db, { uid: booked.uid });
    assert.equal(result.status, "cancelled");
    assert.equal(result.replay, false);
    assert.equal(result.uid, booked.uid);

    const [row] = await db.$client.execute(
      "SELECT status, cancelled_at FROM bookings WHERE uid = ?",
      [booked.uid]
    ).then((r) => r.rows);
    assert.equal(row!.status, "cancelled");
    assert.ok(row!.cancelled_at, "cancelled_at must be stamped");

    const ticksAfter = await db.$client.execute(
      "SELECT COUNT(*) AS n FROM host_occupancy_ticks WHERE host_user_id = 1"
    );
    assert.equal(Number(ticksAfter.rows[0]!.n), 0, "ticks must be pruned on cancel");

    // The freed slot must be bookable again by a different request.
    const rebooked = await createBookingHandler(
      db,
      bookingInput({ slotStartUtc: start, slotEndUtc: end, idempotencyKey: "cancel-b" })
    );
    assert.equal(rebooked.status, "accepted");
  } finally {
    close();
  }
});

test("cancel is idempotent by uid", async () => {
  const { db, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await seedIndividual(db);
    const booked = await createBookingHandler(
      db,
      bookingInput({
        slotStartUtc: "2027-06-01T10:00:00.000Z",
        slotEndUtc: "2027-06-01T11:00:00.000Z",
        idempotencyKey: "idem-cancel",
      })
    );

    const first = await cancelBookingHandler(db, { uid: booked.uid });
    assert.equal(first.status, "cancelled");
    assert.equal(first.replay, false);

    const second = await cancelBookingHandler(db, { uid: booked.uid });
    assert.equal(second.uid, booked.uid);
    assert.equal(second.status, "cancelled");
    assert.equal(second.replay, true);
  } finally {
    close();
  }
});

test("cancel by idempotency key and 404 on unknown booking", async () => {
  const { db, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await seedIndividual(db);
    const booked = await createBookingHandler(
      db,
      bookingInput({
        slotStartUtc: "2027-06-01T10:00:00.000Z",
        slotEndUtc: "2027-06-01T11:00:00.000Z",
        idempotencyKey: "by-key",
      })
    );

    const byKey = await cancelBookingHandler(db, { idempotencyKey: "by-key" });
    assert.equal(byKey.uid, booked.uid);
    assert.equal(byKey.status, "cancelled");

    await assert.rejects(cancelBookingHandler(db, { uid: "no-such-uid" }), BookingNotFoundError);
    await assert.rejects(
      cancelBookingHandler(db, { idempotencyKey: "no-such-key" }),
      BookingNotFoundError
    );
    await assert.rejects(cancelBookingHandler(db, {}), /requires uid or idempotencyKey/);
  } finally {
    close();
  }
});

test("findOrphanedTicks reports ticks whose booking row disappeared", async () => {
  const { db, file, close } = await openTestDb();
  try {
    await seedUsersAndHours(db);
    await seedIndividual(db);
    const booked = await createBookingHandler(
      db,
      bookingInput({
        slotStartUtc: "2027-06-01T10:00:00.000Z",
        slotEndUtc: "2027-06-01T11:00:00.000Z",
        idempotencyKey: "orphan-a",
      })
    );

    assert.deepEqual(await findOrphanedTicks(db), []);

    // Simulate the failure mode (booking row lost without tick pruning) by
    // deleting the booking on a client with foreign keys off.
    const raw = createClient({ url: `file:${file}` });
    await raw.execute("PRAGMA foreign_keys = OFF");
    await raw.execute({ sql: "DELETE FROM bookings WHERE uid = ?", args: [booked.uid] });

    const orphans = await findOrphanedTicks(db);
    assert.equal(orphans.length, 60);
    assert.equal(orphans.every((o) => o.hostUserId === 1), true);
    await raw.close();
  } finally {
    close();
  }
});
