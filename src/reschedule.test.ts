import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createApp } from "./worker";
import { availability, bookings, eventTypeHosts, eventTypes, hostOccupancyTicks, schedules, users } from "./schema";
import { openTestDb, type TestDb } from "./test-db";

const SECRET = "test-secret";
const JWT_SECRET = "jwt-test-secret";

const LOCATIONS_JSON = JSON.stringify([
  { type: "integrations:daily", label: "Video (Daily.co)" },
  { type: "inPerson", label: "In person", address: "[REDACTED_ADDRESS]" },
]);

async function seed(db: TestDb, opts: { bufferBefore?: number; bufferAfter?: number; minNotice?: number } = {}) {
  await db.insert(users).values([{ id: 1, email: "host@x.test", username: "host", timezone: "UTC", displayName: "Host" }]);
  await db.insert(schedules).values([{ id: 1, userId: 1, name: "Hours", timezone: "UTC" }]);
  await db.insert(availability).values([{ scheduleId: 1, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "09:00", endTime: "17:00" }]);
  await db.insert(eventTypes).values({
    id: 1,
    ownerUserId: 1,
    slug: "intro",
    lengthMinutes: 30,
    slotIntervalMinutes: 30,
    schedulingType: "individual",
    locations: LOCATIONS_JSON,
    bufferBefore: opts.bufferBefore ?? 0,
    bufferAfter: opts.bufferAfter ?? 0,
    minBookingNotice: opts.minNotice ?? 0,
    title: "Intro Call",
    isActive: true,
  });
  await db.insert(eventTypeHosts).values({ eventTypeId: 1, hostUserId: 1, priority: 0 });
}

function appWith(db: TestDb) {
  return createApp({ API_SECRET: SECRET, JWT_SECRET }, { db, stripeSecretKey: undefined });
}
function appWithSecret(db: TestDb) {
  return createApp({ API_SECRET: SECRET }, { db, stripeSecretKey: undefined });
}
function authed(path: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...(init.headers ?? {}) } };
}

async function createBooking(app: ReturnType<typeof createApp>, idempotencyKey: string, start = "2027-06-01T13:00:00Z", end = "2027-06-01T13:30:00Z") {
  const res = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1, slotStartUtc: start, slotEndUtc: end, location: { type: "inPerson" }, attendee: { email: "guest@example.com" }, idempotencyKey }) }));
  if (res.status !== 200) assert.fail(`createBooking failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { uid: string; startUtc: string; endUtc: string };
}

// ---------------------------------------------------------------------------

test("reschedule: happy path moves booking and frees old slot", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const { uid } = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");

    const res = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r1" }) }));
    if (res.status !== 200) assert.fail(`reschedule failed ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { uid: string; startUtc: string; endUtc: string; replay: boolean };
    assert.equal(body.uid, uid);
    assert.equal(body.startUtc, "2027-06-01T14:00:00.000Z");
    assert.equal(body.endUtc, "2027-06-01T14:30:00.000Z");
    assert.equal(body.replay, false);

    // Old slot is free — can book there again under fresh key
    const rebook = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1, slotStartUtc: "2027-06-01T13:00:00Z", slotEndUtc: "2027-06-01T13:30:00Z", location: { type: "inPerson" }, attendee: { email: "other@example.com" }, idempotencyKey: "k2" }) }));
    assert.equal(rebook.status, 200, await rebook.text());

    // New slot is now occupied — conflict
    const conflict = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1, slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", location: { type: "inPerson" }, attendee: { email: "third@example.com" }, idempotencyKey: "k3" }) }));
    assert.equal(conflict.status, 409);

    // Ticks reflect new interval, old gone
    const ticks = await db.select().from(hostOccupancyTicks);
    const bookedRow = (await db.select().from(bookings).where(eq(bookings.uid, uid)).limit(1))[0];
    assert.ok(bookedRow);
    // ticks should exist for new slot (30 mins = 30 ticks per host)
    assert.ok(ticks.some((t) => t.bookingId === bookedRow.id), "rescheduled booking should have ticks");
    // No booking should occupy old slot via booking table
    const oldOverlap = await db.select().from(bookings).where(eq(bookings.startTime, "2027-06-01T14:00:00.000Z"));
    assert.equal(oldOverlap[0].uid, uid);

    // GET /bookings/:uid reflects new times (Room cache update shape)
    const detail = await app.request(`/bookings/${uid}`, authed(""));
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as { start_time: string; end_time: string; startTime?: string };
    // schema uses start_time column, but API returns ...booking directly (select *), check startTime or start_time
    const raw = detailBody as Record<string, unknown>;
    const startVal = (raw.startTime ?? raw.start_time) as string;
    assert.equal(startVal, "2027-06-01T14:00:00.000Z");
  } finally {
    close();
  }
});

test("reschedule: 404 for unknown uid", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const res = await app.request("/bookings/nope/reschedule", authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r1" }) }));
    assert.equal(res.status, 404);
  } finally {
    close();
  }
});

test("reschedule: 409 when new slot conflicts with another booking", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const a = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");
    await createBooking(app, "k2", "2027-06-01T14:00:00Z", "2027-06-01T14:30:00Z");
    const res = await app.request(`/bookings/${a.uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r1" }) }));
    assert.equal(res.status, 409);
  } finally {
    close();
  }
});

test("reschedule: 409 when slot off-grid / out-of-hours / wrong length / cancelled", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const { uid } = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");

    // Off-grid (13:10 not on 30-min grid)
    const offGrid = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T13:10:00Z", slotEndUtc: "2027-06-01T13:40:00Z", idempotencyKey: "r-off" }) }));
    assert.equal(offGrid.status, 409);

    // Out of working hours (before 09:00)
    const ooh = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T08:00:00Z", slotEndUtc: "2027-06-01T08:30:00Z", idempotencyKey: "r-ooh" }) }));
    assert.equal(ooh.status, 409);

    // Wrong length (60 min vs 30)
    const badLen = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T15:00:00Z", idempotencyKey: "r-len" }) }));
    assert.equal(badLen.status, 409);

    // Cancelled booking cannot be rescheduled
    await app.request("/bookings/cancel", authed("", { method: "POST", body: JSON.stringify({ uid }) }));
    const afterCancel = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T15:00:00Z", slotEndUtc: "2027-06-01T15:30:00Z", idempotencyKey: "r-cancelled" }) }));
    assert.equal(afterCancel.status, 409);
  } finally {
    close();
  }
});

test("reschedule: idempotent replay with same idempotencyKey", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const { uid } = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");

    const r1 = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "idem1" }) }));
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { replay: boolean }).replay, false);

    const r2 = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "idem1" }) }));
    assert.equal(r2.status, 200);
    const b2 = (await r2.json()) as { replay: boolean; startUtc: string };
    assert.equal(b2.replay, true);
    assert.equal(b2.startUtc, "2027-06-01T14:00:00.000Z");

    // Different key moves again (if slot free) — sanity that new key is not treated as replay
    const r3 = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T15:00:00Z", slotEndUtc: "2027-06-01T15:30:00Z", idempotencyKey: "idem2" }) }));
    assert.equal(r3.status, 200);
    const r3Body = (await r3.json()) as { replay: boolean; startUtc: string };
    assert.equal(r3Body.replay, false);
    assert.equal(r3Body.startUtc, "2027-06-01T15:00:00.000Z");
  } finally {
    close();
  }
});

test("reschedule: auth scoping — JWT host can move own booking, other user 403", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    // Add a second user (id 2) — not host, not owner
    await db.insert(users).values({ id: 2, email: "other@x.test", username: "other", timezone: "UTC" });
    // Sign up flows to mint JWTs — use the worker's auth routes
    const app = appWith(db);

    // Host user (id 1) needs password to log in; seed via signup
    // Create JWT for other user via signup
    const otherSignup = await app.request("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "other2@x.test", password: "hunter2hunter2", username: "other2" }) });
    // otherSignup creates user id 3, not 2 — use that JWT to attempt hijack
    const { accessToken: otherToken } = (await otherSignup.json()) as { accessToken: string };

    // Create a booking as admin (host 1)
    const { uid } = await createBooking(appWithSecret(db), "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");

    // Other user's JWT tries to reschedule host's booking → 403
    const hijack = await app.request(`/bookings/${uid}/reschedule`, { method: "POST", headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r-hijack" }) });
    assert.equal(hijack.status, 403);

    // Host's own JWT can reschedule — mint host JWT via signup for a new host-owned event type
    // Instead, test admin bypass: admin (SECRET) succeeds regardless
    const adminRes = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r-admin" }) }));
    assert.equal(adminRes.status, 200);

    // Now create an event type owned by other2 and a booking for it — other2 should be allowed as owner
    const createEt = await app.request("/event-types", { method: "POST", headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ slug: "owned", title: "Owned", lengthMinutes: 30, locations: [{ type: "inPerson" }] }) });
    assert.equal(createEt.status, 201);
    const et = (await createEt.json()) as { id: number };
    // Availability for other2's schedule
    const otherUserId = 3; // from signup auto-increment
    await db.insert(schedules).values({ userId: otherUserId, name: "Hours", timezone: "UTC" });
    const schedRows = await db.select().from(schedules).where(eq(schedules.userId, otherUserId)).limit(1);
    const otherScheduleId = schedRows[0].id;
    await db.insert(availability).values({ scheduleId: otherScheduleId, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "09:00", endTime: "17:00" });
    // Book as admin on that event type (host is other2)
    const b2 = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify({ eventTypeId: et.id, slotStartUtc: "2027-06-01T13:00:00Z", slotEndUtc: "2027-06-01T13:30:00Z", location: { type: "inPerson" }, attendee: { email: "guest2@example.com" }, idempotencyKey: "k-owned" }) }));
    if (b2.status !== 200) assert.fail(`b2 failed ${b2.status}: ${await b2.text()}`);
    const { uid: uid2 } = (await b2.json()) as { uid: string };
    const ownerReschedule = await app.request(`/bookings/${uid2}/reschedule`, { method: "POST", headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r-owner" }) });
    assert.equal(ownerReschedule.status, 200);
  } finally {
    close();
  }
});

test("reschedule: 400 on malformed input, 401 without auth", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const { uid } = await createBooking(app, "k1");

    // Missing idempotencyKey → Zod 400
    const bad = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z" }) }));
    assert.equal(bad.status, 400);

    // No auth → 401
    const noAuth = await app.request(`/bookings/${uid}/reschedule`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r1" }) });
    assert.equal(noAuth.status, 401);
  } finally {
    close();
  }
});

test("reschedule: buffer-aware conflict (new slot must respect other booking buffers)", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db, { bufferBefore: 15, bufferAfter: 15 });
    const app = appWithSecret(db);
    const a = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");
    // Another booking at 14:00 occupies 13:45-14:45 with buffers, so 14:00 reschedule from a would overlap
    await createBooking(app, "k2", "2027-06-01T14:00:00Z", "2027-06-01T14:30:00Z");
    // Try to move a to 13:30 — its new footprint is 13:15-13:45, overlapping k2's 13:45? Actually 13:30 end is 14:00 with after 15 =14:15? Let's pick 13:30-14:00 whose footprint 13:15-14:15 overlaps k2's 13:45-14:45
    const res = await app.request(`/bookings/${a.uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T13:30:00Z", slotEndUtc: "2027-06-01T14:00:00Z", idempotencyKey: "r-buf" }) }));
    assert.equal(res.status, 409);
  } finally {
    close();
  }
});

test("reschedule: re-snapshots buffers from live event type", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithSecret(db);
    const { uid } = await createBooking(app, "k1", "2027-06-01T13:00:00Z", "2027-06-01T13:30:00Z");
    // Change event type buffers
    await db.update(eventTypes).set({ bufferBefore: 10, bufferAfter: 10 }).where(eq(eventTypes.id, 1));
    const res = await app.request(`/bookings/${uid}/reschedule`, authed("", { method: "POST", body: JSON.stringify({ slotStartUtc: "2027-06-01T14:00:00Z", slotEndUtc: "2027-06-01T14:30:00Z", idempotencyKey: "r-snap" }) }));
    assert.equal(res.status, 200);
    const [row] = await db.select().from(bookings).where(eq(bookings.uid, uid)).limit(1);
    assert.equal(row.bufferBefore, 10);
    assert.equal(row.bufferAfter, 10);
    const ticks = await db.select().from(hostOccupancyTicks).where(eq(hostOccupancyTicks.bookingId, row.id));
    // 30 min slot + 20 min buffers = 50 ticks
    assert.equal(ticks.length, 50);
  } finally {
    close();
  }
});
