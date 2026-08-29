import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createApp } from "./worker";
import { attendees, availability, eventTypeHosts, eventTypes, schedules, users } from "./schema";
import { openTestDb, type TestDb } from "./test-db";

const SECRET = "test-secret";

const LOCATIONS_JSON = JSON.stringify([
  { type: "integrations:daily", label: "Video (Daily.co)" },
  { type: "inPerson", label: "In person", address: "[REDACTED_ADDRESS]" },
]);

async function seed(db: TestDb) {
  await db.insert(users).values([
    { id: 1, email: "host@x.test", username: "host", timezone: "UTC", displayName: "Host", avatarUrl: "" },
  ]);
  await db.insert(schedules).values([{ id: 1, userId: 1, name: "Hours", timezone: "UTC" }]);
  await db.insert(availability).values([
    { scheduleId: 1, dayOfWeek: null, dateOverride: "2027-06-01", startTime: "09:00", endTime: "17:00" },
  ]);
  await db.insert(eventTypes).values({
    id: 1,
    ownerUserId: 1,
    slug: "intro",
    lengthMinutes: 30,
    slotIntervalMinutes: 30,
    schedulingType: "individual",
    locations: LOCATIONS_JSON,
    minBookingNotice: 0,
    title: "Intro Call",
    description: "A quick intro.",
    priceInCents: 5000,
    currency: "usd",
    colorHex: "#CC785C",
    isActive: true,
  });
  await db.insert(eventTypeHosts).values({ eventTypeId: 1, hostUserId: 1, priority: 0 });
}

function appWith(db: TestDb) {
  return createApp(
    { API_SECRET: SECRET },
    { db, stripeSecretKey: undefined }
  );
}

function authed(path: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  };
}

test("health is open; everything else requires the bearer secret", async () => {
  const { db, close } = await openTestDb();
  try {
    const app = appWith(db);
    const health = await app.request("/health");
    assert.equal(health.status, 200);

    const denied = await app.request("/event-types");
    assert.equal(denied.status, 401);

    const wrong = await app.request("/event-types", { headers: { Authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  } finally {
    close();
  }
});

test("GET /event-types returns app-facing columns and host ids", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request("/event-types", authed(""));
    assert.equal(res.status, 200);
    const [et] = (await res.json()) as Array<Record<string, unknown>>;
    assert.equal(et.title, "Intro Call");
    assert.equal(et.priceInCents, 5000);
    assert.equal(et.colorHex, "#CC785C");
    assert.equal(et.isActive, true);
    assert.deepEqual(et.hostUserIds, [1]);
  } finally {
    close();
  }
});

test("GET /availability returns engine slots; bad input is 400", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const ok = await app.request(
      "/availability?eventTypeId=1&rangeStartUtc=2027-06-01T00:00:00Z&rangeEndUtc=2027-06-02T00:00:00Z",
      authed("")
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { slots: Array<{ startUtc: string; schedulingType: string }> };
    assert.equal(body.slots.length, 16); // 09:00–17:00 on the 30-min grid
    assert.equal(body.slots[0].startUtc, "2027-06-01T09:00:00.000Z");
    assert.equal(body.slots[0].schedulingType, "individual");

    const bad = await app.request(
      "/availability?eventTypeId=1&rangeStartUtc=not-a-time&rangeEndUtc=2027-06-02T00:00:00Z",
      authed("")
    );
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});

test("POST /bookings creates, replays by idempotency key, stamps created_at, and conflicts 409", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const input = {
      eventTypeId: 1,
      slotStartUtc: "2027-06-01T13:00:00Z",
      slotEndUtc: "2027-06-01T13:30:00Z",
      location: { type: "inPerson" },
      attendee: { email: "guest@example.com", name: "Guest" },
      idempotencyKey: "k1",
    };
    const created = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify(input) }));
    assert.equal(created.status, 200);
    const result = (await created.json()) as { uid: string; replay: boolean; status: string };
    assert.equal(result.replay, false);
    assert.equal(result.status, "accepted");

    const [row] = await db.select().from(eventTypes).where(eq(eventTypes.id, 1)); // warm read path sanity
    assert.ok(row);
    const bookings1 = await db.query.bookings.findMany();
    assert.equal(bookings1.length, 1);
    assert.ok(bookings1[0].createdAt, "created_at should be stamped at insert");

    const replay = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify(input) }));
    assert.equal(replay.status, 200);
    const replayBody = (await replay.json()) as { replay: boolean };
    assert.equal(replayBody.replay, true);

    // Same slot, different idempotency key → SlotConflictError → 409
    const conflict = await app.request(
      "/bookings",
      authed("", { method: "POST", body: JSON.stringify({ ...input, idempotencyKey: "k2" }) })
    );
    assert.equal(conflict.status, 409);

    // Booking detail read path
    const detail = await app.request(`/bookings/${result.uid}`, authed(""));
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as { attendee: { email: string } | null };
    assert.equal(detailBody.attendee?.email, "guest@example.com");
  } finally {
    close();
  }
});

test("cancel: unknown uid 404, known uid cancels and frees the slot", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const created = await app.request(
      "/bookings",
      authed("", {
        method: "POST",
        body: JSON.stringify({
          eventTypeId: 1,
          slotStartUtc: "2027-06-01T13:00:00Z",
          slotEndUtc: "2027-06-01T13:30:00Z",
          location: { type: "inPerson" },
          attendee: { email: "guest@example.com" },
          idempotencyKey: "k1",
        }),
      })
    );
    const { uid } = (await created.json()) as { uid: string };

    const missing = await app.request(
      "/bookings/cancel",
      authed("", { method: "POST", body: JSON.stringify({ uid: "nope" }) })
    );
    assert.equal(missing.status, 404);

    const cancelled = await app.request(
      "/bookings/cancel",
      authed("", { method: "POST", body: JSON.stringify({ uid }) })
    );
    assert.equal(cancelled.status, 200);
    const body = (await cancelled.json()) as { status: string; replay: boolean };
    assert.equal(body.status, "cancelled");

    // Slot is free again: same slot books under a fresh key
    const rebooked = await app.request(
      "/bookings",
      authed("", {
        method: "POST",
        body: JSON.stringify({
          eventTypeId: 1,
          slotStartUtc: "2027-06-01T13:00:00Z",
          slotEndUtc: "2027-06-01T13:30:00Z",
          location: { type: "inPerson" },
          attendee: { email: "other@example.com" },
          idempotencyKey: "k2",
        }),
      })
    );
    assert.equal(rebooked.status, 200);
  } finally {
    close();
  }
});

test("payments endpoints refuse to run without STRIPE_SECRET_KEY (503) and validate input", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request(
      "/payments/create-intent",
      authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1 }) })
    );
    assert.equal(res.status, 503);

    const mark = await app.request(
      "/payments/mark-paid",
      authed("", { method: "POST", body: JSON.stringify({ uid: "x" }) })
    );
    assert.equal(mark.status, 503);
  } finally {
    close();
  }
});

test("attendee notes column round-trips through the read path", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const created = await app.request(
      "/bookings",
      authed("", {
        method: "POST",
        body: JSON.stringify({
          eventTypeId: 1,
          slotStartUtc: "2027-06-01T13:00:00Z",
          slotEndUtc: "2027-06-01T13:30:00Z",
          location: { type: "inPerson" },
          attendee: { email: "guest@example.com" },
          idempotencyKey: "k1",
        }),
      })
    );
    const { uid } = (await created.json()) as { uid: string };
    await db.update(attendees).set({ notes: "prefers mornings" });
    const detailRes = await app.request(`/bookings/${uid}`, authed(""));
    const detail = (await detailRes.json()) as { attendee: { notes: string } | null };
    assert.equal(detail.attendee?.notes, "prefers mornings");
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// /me — user settings (profile, timezone, metadata contract)
// ---------------------------------------------------------------------------

test("GET /me returns the primary user with schedule and parsed metadata", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request("/me", authed());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 1);
    assert.equal(body.email, "host@x.test");
    assert.equal(body.displayName, "Host");
    assert.deepEqual(body.metadata, {});
    assert.deepEqual(body.schedule, { id: 1, name: "Hours", timezone: "UTC" });
  } finally {
    close();
  }
});

test("GET /me 404s when no users exist; ?userId= selects a specific user", async () => {
  const { db, close } = await openTestDb();
  try {
    const app = appWith(db);
    const missing = await app.request("/me", authed());
    assert.equal(missing.status, 404);
    await db.insert(users).values([
      { id: 1, email: "a@x.test", username: "a", timezone: "UTC" },
      { id: 2, email: "b@x.test", username: "b", timezone: "UTC" },
    ]);
    const targeted = await app.request("/me?userId=2", authed());
    assert.equal((await targeted.json()).username, "b");
    const badParam = await app.request("/me?userId=nope", authed());
    assert.equal(badParam.status, 400);
  } finally {
    close();
  }
});

test("PATCH /me updates profile fields and validates input", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request(
      "/me",
      authed("", { method: "PATCH",
        body: JSON.stringify({
          displayName: "Alex Rivera",
          avatarUrl: "https://cdn.example/avatar.png",
          metadata: {
            defaultLocation: { type: "userPhone", label: "My phone", phone: "+15555550123" },
            prefs: { timeFormat: "24h" },
          },
        }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.displayName, "Alex Rivera");
    assert.equal(body.metadata.defaultLocation.type, "userPhone");
    assert.equal(body.metadata.prefs.timeFormat, "24h");

    // Empty patch is 400; unknown fields rejected; bad timezone rejected.
    assert.equal((await app.request("/me", authed("", { method: "PATCH", body: "{}" }))).status, 400);
    assert.equal((await app.request("/me", authed("", { method: "PATCH", body: '{"nope":1}' }))).status, 400);
    assert.equal(
      (await app.request("/me", authed("", { method: "PATCH", body: '{"timezone":"Mars/Olympus"}' }))).status,
      400
    );
    // Bad metadata shape rejected loudly (strict schema).
    assert.equal(
      (await app.request("/me", authed("", { method: "PATCH", body: '{"metadata":{"prefs":{"timeFormat":"25h"}}}' })))
        .status,
      400
    );
  } finally {
    close();
  }
});

test("PATCH /me maps unique clashes to 409", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    await db.insert(users).values({ id: 2, email: "other@x.test", username: "other", timezone: "UTC" });
    const app = appWith(db);
    const emailClash = await app.request(
      "/me?userId=2",
      authed("", { method: "PATCH", body: JSON.stringify({ email: "host@x.test" }) })
    );
    assert.equal(emailClash.status, 409);
    const usernameClash = await app.request(
      "/me?userId=2",
      authed("", { method: "PATCH", body: JSON.stringify({ username: "host" }) })
    );
    assert.equal(usernameClash.status, 409);
    // Same-user no-op update is fine.
    const self = await app.request("/me", authed("", { method: "PATCH", body: JSON.stringify({ username: "host" }) }));
    assert.equal(self.status, 200);
  } finally {
    close();
  }
});

test("PATCH /me/schedule updates schedule and keeps users.timezone in lockstep", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request(
      "/me/schedule",
      authed("", { method: "PATCH", body: JSON.stringify({ name: "Deep Work", timezone: "America/New_York" }) })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.schedule, { id: 1, name: "Deep Work", timezone: "America/New_York" });
    assert.equal(body.timezone, "America/New_York");
    // Timezone-only patch leaves the name alone.
    const tzOnly = await app.request(
      "/me/schedule",
      authed("", { method: "PATCH", body: JSON.stringify({ timezone: "Europe/Berlin" }) })
    );
    const tzBody = await tzOnly.json();
    assert.equal(tzBody.schedule.name, "Deep Work");
    assert.equal(tzBody.schedule.timezone, "Europe/Berlin");
    // Missing schedule row is created (fresh user without one).
    await db.insert(users).values({ id: 3, email: "c@x.test", username: "c", timezone: "UTC" });
    const created = await app.request(
      "/me/schedule?userId=3",
      authed("", { method: "PATCH", body: JSON.stringify({ timezone: "UTC" }) })
    );
    assert.equal((await created.json()).schedule.name, "Working Hours");
  } finally {
    close();
  }
});
