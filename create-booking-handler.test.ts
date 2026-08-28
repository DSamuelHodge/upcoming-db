import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateBookingInput,
  createBookingHandler,
  SlotConflictError,
} from "./create-booking-handler";
import { loadEventType } from "./event-types";
import { attendees, availability, eventTypeHosts, eventTypes, schedules, users } from "./schema";
import { openDb, openTestDb } from "./test-db";

const LOCATIONS_JSON = JSON.stringify([
  { type: "integrations:daily", label: "Video (Daily.co)" },
  { type: "inPerson", label: "In person — Brick House Blue, Hilliard", address: "4022 Green Stripe Lane, Hilliard, OH 43026" },
  { type: "userPhone", label: "Phone", phone: "+16144074920", displayPhone: "(614) 407-4920" },
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
