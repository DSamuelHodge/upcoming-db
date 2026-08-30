import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createApp } from "./worker";
import { attendees, availability, eventTypeHosts, eventTypes, schedules, singleUseLinks, users } from "./schema";
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
    const res = await app.request("/me", authed(""));
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
    const missing = await app.request("/me", authed(""));
    assert.equal(missing.status, 404);
    await db.insert(users).values([
      { id: 1, email: "a@x.test", username: "a", timezone: "UTC" },
      { id: 2, email: "b@x.test", username: "b", timezone: "UTC" },
    ]);
    const targeted = await app.request("/me?userId=2", authed(""));
    assert.equal((await targeted.json()).username, "b");
    const badParam = await app.request("/me?userId=nope", authed(""));
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
    // Bad reminder offsets rejected (zero/negative, non-integer, too many).
    for (const bad of ["0", "-5", "9.5", "10081", '"10"']) {
      const res = await app.request(
        "/me",
        authed("", { method: "PATCH", body: `{"metadata":{"prefs":{"timeFormat":"24h","reminderOffsets":[${bad}]}}}` })
      );
      assert.equal(res.status, 400, `reminderOffsets ${bad} should be rejected`);
    }
  } finally {
    close();
  }
});

test("metadata contract: reminder offsets normalize (dedupe, sort, cap)", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const res = await app.request(
      "/me",
      authed("", {
        method: "PATCH",
        body: JSON.stringify({ metadata: { prefs: { timeFormat: "12h", reminderOffsets: [60, 10, 60, 1440] } } }),
      })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // Sorted ascending, deduped.
    assert.deepEqual(body.metadata.prefs.reminderOffsets, [10, 60, 1440]);

    // More than 5 distinct offsets is rejected.
    const tooMany = await app.request(
      "/me",
      authed("", {
        method: "PATCH",
        body: JSON.stringify({ metadata: { prefs: { timeFormat: "12h", reminderOffsets: [1, 2, 3, 4, 5, 6] } } }),
      })
    );
    assert.equal(tooMany.status, 400);
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

test("metadata contract accepts the seeded role/company profile context", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    await db.update(users).set({ metadata: '{"role":"Product Lead","company":"Upcoming Labs"}' }).where(eq(users.id, 1));
    const app = appWith(db);
    const res = await app.request("/me", authed(""));
    assert.equal((await res.json()).metadata.company, "Upcoming Labs");
    const patch = await app.request(
      "/me",
      authed("", { method: "PATCH", body: JSON.stringify({ metadata: { role: "Founder", company: "ACME" } }) })
    );
    assert.equal((await patch.json()).metadata.role, "Founder");
  } finally {
    close();
  }
});

test("metadata contract: per-type location defaults + defaultLocationType", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const patch = await app.request(
      "/me",
      authed("", {
        method: "PATCH",
        body: JSON.stringify({
          metadata: {
            locations: {
              "integrations:daily": { type: "integrations:daily", label: "My Room", url: "https://team.daily.co/perm" },
              inPerson: { type: "inPerson", label: "Office", address: "[REDACTED_ADDRESS]" },
              userPhone: { type: "userPhone", label: "Cell", phone: "+15555550123" },
            },
            defaultLocationType: "inPerson",
          },
        }),
      })
    );
    assert.equal(patch.status, 200);
    const body = await patch.json();
    assert.equal(body.metadata.locations.inPerson.label, "Office");
    assert.equal(body.metadata.defaultLocationType, "inPerson");
    // Unknown defaultLocationType rejected.
    const bad = await app.request(
      "/me",
      authed("", { method: "PATCH", body: JSON.stringify({ metadata: { defaultLocationType: "carrierPigeon" } }) })
    );
    assert.equal(bad.status, 400);
  } finally {
    close();
  }
});

test("credentials: put/replace/list(masked)/delete round-trip", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    const app = appWith(db);
    try {
      const put = await app.request(
        "/me/credentials/daily_api_key",
        authed("", { method: "PUT", body: JSON.stringify({ value: "daily-key-abcd1234" }) })
      );
      assert.equal(put.status, 200);
      assert.equal((await put.json()).hint, "••••1234");

      // Replace keeps one row.
      await app.request(
        "/me/credentials/daily_api_key",
        authed("", { method: "PUT", body: JSON.stringify({ value: "daily-key-xyz9999" }) })
      );

      // Unknown type is 400; bad URL is 400.
      assert.equal(
        (await app.request("/me/credentials/nope", authed("", { method: "PUT", body: '{"value":"x"}' }))).status,
        400
      );
      assert.equal(
        (
          await app.request(
            "/me/credentials/ical_url",
            authed("", { method: "PUT", body: '{"value":"not-a-url"}' })
          )
        ).status,
        400
      );

      // List returns hints only — ciphertext never leaks.
      const list = await app.request("/me/credentials", authed(""));
      const rows = (await list.json()) as Array<{ type: string; hint: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].hint, "••••9999");
      assert.ok(!JSON.stringify(rows).includes("daily-key"));

      const del = await app.request("/me/credentials/daily_api_key", authed("", { method: "DELETE" }));
      assert.equal(del.status, 200);
      const delAgain = await app.request("/me/credentials/daily_api_key", authed("", { method: "DELETE" }));
      assert.equal(delAgain.status, 404);
    } finally {
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  } finally {
    close();
  }
});

// ---------------------------------------------------------------------------
// Auth (JWT sign-up/login/refresh/logout) — phase-7
// ---------------------------------------------------------------------------

const JWT_SECRET = "jwt-test-secret";

function appWithAuth(db: TestDb) {
  return createApp({ API_SECRET: SECRET, JWT_SECRET }, { db });
}

test("auth: signup mints tokens and a passwordless seed user cannot log in", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithAuth(db);

    const res = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new@x.test",
        password: "hunter2hunter2",
        username: "newbie",
        displayName: "New Bee",
        timezone: "Europe/Berlin",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.email, "new@x.test");
    assert.equal(body.user.username, "newbie");
    assert.equal(typeof body.accessToken, "string");
    assert.ok(body.refreshToken.length >= 40);

    // Duplicate email / username are 409; bad password is 400.
    assert.equal(
      (await app.request("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@x.test", password: "hunter2hunter2", username: "other" }) })).status,
      409
    );
    assert.equal(
      (await app.request("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fresh@x.test", password: "hunter2hunter2", username: "newbie" }) })).status,
      409
    );
    assert.equal(
      (await app.request("/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fresh@x.test", password: "short", username: "fresh" }) })).status,
      400
    );

    // Passwordless (seeded) user cannot log in; unknown email gets the same
    // uniform 401.
    for (const creds of [
      { email: "host@x.test", password: "anything123" },
      { email: "ghost@x.test", password: "anything123" },
    ]) {
      const login = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds),
      });
      assert.equal(login.status, 401);
      assert.equal((await login.json()).error, "invalid email or password");
    }
  } finally {
    close();
  }
});

test("auth: login + JWT-scoped /me replaces lowest-id resolution", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithAuth(db);
    const signup = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@x.test", password: "hunter2hunter2", username: "mee" }),
    });
    const { accessToken } = await signup.json();

    // /me with the JWT returns the JWT subject, not the lowest-id user.
    const me = await app.request("/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).username, "mee");

    // ?userId= pointing elsewhere is forbidden with a JWT.
    const hijack = await app.request("/me?userId=1", { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(hijack.status, 403);

    // Garbage token falls through to the secret path: without the secret → 401.
    assert.equal((await app.request("/me", { headers: { Authorization: "Bearer not.a.jwt" } })).status, 401);
    // …and with the shared secret → legacy admin behavior (lowest-id user).
    const legacy = await app.request("/me", authed(""));
    assert.equal((await legacy.json()).username, "host");

    // Wrong password 401.
    const bad = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@x.test", password: "wrong-wrong" }),
    });
    assert.equal(bad.status, 401);

    // Right password 200.
    const good = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@x.test", password: "hunter2hunter2" }),
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).user.username, "mee");
  } finally {
    close();
  }
});

test("auth: refresh rotates sessions; logout revokes; reuse fails", async () => {
  const { db, close } = await openTestDb();
  try {
    const app = appWithAuth(db);
    const signup = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rot@x.test", password: "hunter2hunter2", username: "rot" }),
    });
    const first = await signup.json();

    // Refresh with the original token works and issues a new pair.
    const refresh1 = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    assert.equal(refresh1.status, 200);
    const second = await refresh1.json();
    assert.notEqual(second.refreshToken, first.refreshToken);

    // The original token was consumed — reuse is rejected.
    const reuse = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: first.refreshToken }),
    });
    assert.equal(reuse.status, 401);

    // New refresh token → new pair works again.
    const refresh2 = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: second.refreshToken }),
    });
    assert.equal(refresh2.status, 200);
    const third = await refresh2.json();

    // Logout revokes; the token stops working afterwards.
    const logout = await app.request("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: third.refreshToken }),
    });
    assert.equal(logout.status, 200);
    const afterLogout = await app.request("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: third.refreshToken }),
    });
    assert.equal(afterLogout.status, 401);

    // Bogus refresh tokens are 401.
    assert.equal(
      (await app.request("/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: "nope" }),
      })).status,
      401
    );
  } finally {
    close();
  }
});

// Single-use booking links (2026-08-30) — create/list/revoke + burn-on-booking
test("single-use links: create, list, revoke (admin path)", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);

    const created = await app.request(
      "/single-use-links",
      authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1, count: 2 }) })
    );
    assert.equal(created.status, 201);
    const links = (await created.json()) as Array<Record<string, unknown>>;
    assert.equal(links.length, 2);
    assert.notEqual(links[0].token, links[1].token);
    assert.equal(
      links[0].url,
      `https://getupcoming.app/host/intro?lid=${links[0].token}`
    );
    assert.equal(links[0].status, "unused");

    const listed = await app.request("/single-use-links?eventTypeId=1", authed(""));
    assert.equal(listed.status, 200);
    assert.equal(((await listed.json()) as unknown[]).length, 2);

    const revoked = await app.request(`/single-use-links/${links[0].id}`, authed("", { method: "DELETE" }));
    assert.equal(revoked.status, 200);
    const afterList = await app.request("/single-use-links?eventTypeId=1", authed(""));
    const rows = (await afterList.json()) as Array<{ id: number; status: string }>;
    assert.equal(rows.find((r) => r.id === links[0].id)?.status, "revoked");
    assert.equal(rows.find((r) => r.id === links[1].id)?.status, "unused");

    // Revoking twice stays idempotent.
    const again = await app.request(`/single-use-links/${links[0].id}`, authed("", { method: "DELETE" }));
    assert.equal(again.status, 200);

    // Validation: missing/unknown eventTypeId.
    assert.equal((await app.request("/single-use-links", authed(""))).status, 400);
    const unknown = await app.request(
      "/single-use-links",
      authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 999 }) })
    );
    assert.equal(unknown.status, 404);
  } finally {
    close();
  }
});

test("single-use links: JWT user can manage own links, not another owner's", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWithAuth(db);
    const signup = await app.request("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "link@x.test", password: "hunter2hunter2", username: "linker" }),
    });
    const { accessToken } = (await signup.json()) as { accessToken: string };
    const jwt = { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } };

    // Someone else's event type → 403.
    const foreign = await app.request(
      "/single-use-links",
      { ...jwt, method: "POST", body: JSON.stringify({ eventTypeId: 1 }) }
    );
    assert.equal(foreign.status, 403);

    // Own event type → 201, URL carries their username.
    await db.insert(eventTypes).values({
      id: 2,
      ownerUserId: 2,
      slug: "own-call",
      lengthMinutes: 30,
      schedulingType: "individual",
      locations: LOCATIONS_JSON,
      minBookingNotice: 0,
      title: "Own Call",
      isActive: true,
    });
    await db.insert(eventTypeHosts).values({ eventTypeId: 2, hostUserId: 2, priority: 0 });
    const own = await app.request(
      "/single-use-links",
      { ...jwt, method: "POST", body: JSON.stringify({ eventTypeId: 2 }) }
    );
    assert.equal(own.status, 201);
    const [link] = (await own.json()) as Array<{ url: string; status: string }>;
    assert.equal(link.url.startsWith("https://getupcoming.app/linker/own-call?lid="), true);
  } finally {
    close();
  }
});

test("single-use links: burned on booking, reuse rejected, expired rejected", async () => {
  const { db, close } = await openTestDb();
  try {
    await seed(db);
    const app = appWith(db);
    const create = await app.request(
      "/single-use-links",
      authed("", { method: "POST", body: JSON.stringify({ eventTypeId: 1 }) })
    );
    const [link] = (await create.json()) as Array<{ token: string }>;

    const bookingInput = (key: string, start = "14:00", end = "14:30") => ({
      eventTypeId: 1,
      slotStartUtc: `2027-06-01T${start}:00Z`,
      slotEndUtc: `2027-06-01T${end}:00Z`,
      location: { type: "inPerson" },
      attendee: { email: "guest@example.com", name: "Guest" },
      idempotencyKey: key,
      singleUseToken: link.token,
    });

    const created = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify(bookingInput("su-1")) }));
    assert.equal(created.status, 200);

    const listed = await app.request("/single-use-links?eventTypeId=1", authed(""));
    const rows = (await listed.json()) as Array<{ token: string; status: string; usedAt: string | null }>;
    assert.equal(rows.find((r) => r.token === link.token)?.status, "used");
    assert.notEqual(rows.find((r) => r.token === link.token)?.usedAt, null);

    // Reuse is rejected with a 409 and the link stays burned.
    const reuse = await app.request("/bookings", authed("", { method: "POST", body: JSON.stringify(bookingInput("su-2", "15:00", "15:30")) }));
    assert.equal(reuse.status, 409);
    assert.equal(((await reuse.json()) as { error: string }).error, "single-use link has already been used");

    // Unknown token → 409.
    const unknownToken = await app.request(
      "/bookings",
      authed("", { method: "POST", body: JSON.stringify({ ...bookingInput("su-3", "15:30", "16:00"), singleUseToken: "no-such-token-0000" }) })
    );
    assert.equal(unknownToken.status, 409);

    // An expired link cannot book.
    await db.insert(singleUseLinks).values({
      token: "expired-token-123456",
      eventTypeId: 1,
      createdByUserId: 1,
      createdUtc: "2026-01-01T00:00:00.000Z",
      expiresUtc: "2026-01-02T00:00:00.000Z",
    });
    const expired = await app.request(
      "/bookings",
      authed("", { method: "POST", body: JSON.stringify({ ...bookingInput("su-4", "16:00", "16:30"), singleUseToken: "expired-token-123456" }) })
    );
    assert.equal(expired.status, 409);
    assert.equal(((await expired.json()) as { error: string }).error, "single-use link has expired");
  } finally {
    close();
  }
});
