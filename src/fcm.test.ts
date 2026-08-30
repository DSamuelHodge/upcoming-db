import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { bookings, eventTypes, eventTypeHosts, schedules, users } from "./schema";
import {
  bookingEventPush,
  dueReminders,
  parseServiceAccount,
  REMINDER_SWEEP_WINDOW_MS,
  resetFcmAuth,
  runReminderSweep,
  sendPushToUser,
  type FcmEnv,
} from "./fcm";
import { openTestDb } from "./test-db";

const MIN = 60_000;

function installMockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {})) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

async function makeServiceAccount() {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  let b64 = "";
  for (const byte of new Uint8Array(pkcs8)) b64 += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;
  const raw = JSON.stringify({
    project_id: "proj-x",
    client_email: "push@proj-x.iam.gserviceaccount.com",
    private_key: pem,
  });
  return { raw, publicKey: kp.publicKey };
}

function testEnv(serviceAccountRaw: string): FcmEnv {
  return {
    FCM_SERVICE_ACCOUNT: serviceAccountRaw,
    FCM_API_BASE_URL: "https://fcm.test",
    GOOGLE_TOKEN_URL: "https://oauth.test/token",
  };
}

function b64urlDecodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

async function verifyJwtSignature(jwt: string, publicKey: CryptoKey): Promise<void> {
  const [h, p, s] = jwt.split(".");
  const data = new TextEncoder().encode(`${h}.${p}`);
  const signature = Buffer.from(s!, "base64url");
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, data);
  assert.equal(ok, true, "JWT signature must verify against the service-account public key");
}

test("parseServiceAccount rejects incomplete keys", () => {
  assert.throws(() => parseServiceAccount(JSON.stringify({ client_email: "a@b" })), /project_id/);
});

test("dueReminders selects only offsets firing inside the window", () => {
  const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
  const list = [
    { uid: "a", hostUserId: 1, eventTypeName: "Intro", startTime: "2026-08-30T12:20:00.000Z" },
    { uid: "b", hostUserId: 1, eventTypeName: "Intro", startTime: "2026-08-30T13:20:00.000Z" },
    { uid: "c", hostUserId: 2, eventTypeName: "Demo", startTime: "not-a-date" },
  ];
  const due = dueReminders(list, new Map([[1, [10, 30]]]), nowMs, REMINDER_SWEEP_WINDOW_MS);
  // Booking a (starts in 20min): offset 10 fires in 10min → due; offset 30
  // fired 10min ago → skipped. Booking b fires in 70min → outside the window.
  assert.deepEqual(
    due.map((d) => ({ uid: d.uid, offsetMin: d.offsetMin })),
    [{ uid: "a", offsetMin: 10 }]
  );
  // Unmapped user defaults to [10]; invalid dates never match.
  assert.equal(dueReminders([list[2]!], new Map(), nowMs, REMINDER_SWEEP_WINDOW_MS).length, 0);
});

test("sendPushToUser exchanges a verified service-account JWT, sends, and caches the token", async () => {
  resetFcmAuth();
  const sa = await makeServiceAccount();
  const env = testEnv(sa.raw);
  const { db, close } = await openTestDb();
  try {
    await db
      .insert(users)
      .values({ id: 7, email: "u@x.test", username: "u", metadata: JSON.stringify({ fcmToken: "dev-token" }) });
    let tokenExchanges = 0;
    let sends = 0;
    const restore = installMockFetch((url, init) => {
      if (url.startsWith("https://oauth.test/")) {
        tokenExchanges++;
        const body = String(init.body);
        assert.match(body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
        const assertion = new URLSearchParams(body).get("assertion")!;
        const [h, p] = assertion.split(".");
        assert.deepEqual(b64urlDecodeJson(h!), { alg: "RS256", typ: "JWT" });
        const claims = b64urlDecodeJson(p!);
        assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
        assert.equal(claims.iss, "push@proj-x.iam.gserviceaccount.com");
        return verifyJwtSignature(assertion, sa.publicKey).then(() =>
          Response.json({ access_token: "tok-123", expires_in: 3600 })
        );
      }
      assert.ok(url.startsWith("https://fcm.test/v1/projects/proj-x/messages:send"), url);
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer tok-123");
      const body = JSON.parse(String(init.body)) as { message: { token: string; notification: { title: string } } };
      assert.equal(body.message.token, "dev-token");
      assert.equal(body.message.notification.title, "Hello");
      sends++;
      return Response.json({ name: "projects/proj-x/messages/1" });
    });
    const result = await sendPushToUser(db, env, 7, { title: "Hello", body: "World" });
    restore();
    assert.deepEqual(result, { sent: true });
    assert.equal(tokenExchanges, 1);
    assert.equal(sends, 1);

    // Second send within the cache window must skip the token exchange.
    const restore2 = installMockFetch((url) => {
      assert.ok(!url.startsWith("https://oauth.test/"), "token exchange should be cached");
      sends++;
      return Response.json({ name: "projects/proj-x/messages/2" });
    });
    const again = await sendPushToUser(db, env, 7, { title: "Again", body: "Body" });
    restore2();
    assert.deepEqual(again, { sent: true });
    assert.equal(tokenExchanges, 1);
    assert.equal(sends, 2);
  } finally {
    close();
  }
});

test("sendPushToUser clears the stored token when FCM reports it unregistered", async () => {
  resetFcmAuth();
  const sa = await makeServiceAccount();
  const env = testEnv(sa.raw);
  const { db, close } = await openTestDb();
  try {
    await db
      .insert(users)
      .values({ id: 8, email: "u2@x.test", username: "u2", metadata: JSON.stringify({ fcmToken: "stale" }) });
    const restore = installMockFetch((url) => {
      if (url.startsWith("https://oauth.test/")) return Response.json({ access_token: "tok", expires_in: 3600 });
      return new Response("UNREGISTERED", { status: 404 });
    });
    const result = await sendPushToUser(db, env, 8, { title: "t", body: "b" });
    restore();
    assert.deepEqual(result, { sent: false, reason: "token-cleared" });
    const [row] = await db.select({ metadata: users.metadata }).from(users).where(eq(users.id, 8));
    const metadata = JSON.parse(row!.metadata);
    assert.equal(metadata.fcmToken, undefined);
  } finally {
    close();
  }
});

test("runReminderSweep pushes due reminders and honors per-user offsets", async () => {
  resetFcmAuth();
  const sa = await makeServiceAccount();
  const env = testEnv(sa.raw);
  const { db, close } = await openTestDb();
  try {
    const startIso = new Date(Date.now() + 20 * MIN).toISOString();
    await db.insert(users).values([
      {
        id: 1,
        email: "h@x.test",
        username: "h",
        metadata: JSON.stringify({
          fcmToken: "host-device",
          prefs: { timeFormat: "12h", reminderOffsets: [10] },
        }),
      },
    ]);
    await db.insert(schedules).values([{ id: 1, userId: 1, name: "Hours", timezone: "UTC" }]);
    await db.insert(eventTypes).values({
      id: 1,
      ownerUserId: 1,
      title: "Intro",
      slug: "intro",
      lengthMinutes: 30,
      schedulingType: "individual",
      locations: "[]",
      isActive: true,
    });
    await db.insert(eventTypeHosts).values({ eventTypeId: 1, hostUserId: 1, priority: 0 });
    await db.insert(bookings).values({
      uid: "bk-1",
      eventTypeId: 1,
      hostUserId: 1,
      startTime: startIso,
      endTime: new Date(Date.now() + 50 * MIN).toISOString(),
      status: "accepted",
      idempotencyKey: "fcm-test-1",
    });
    const pushes: Array<{ title: string; body: string; data: Record<string, string> }> = [];
    const restore = installMockFetch((url, init) => {
      if (url.startsWith("https://oauth.test/")) return Response.json({ access_token: "tok", expires_in: 3600 });
      const body = JSON.parse(String(init.body)) as {
        message: { notification: { title: string; body: string }; data: Record<string, string> };
      };
      pushes.push({ title: body.message.notification.title, body: body.message.notification.body, data: body.message.data });
      return Response.json({ name: "projects/proj-x/messages/1" });
    });
    const result = await runReminderSweep(db, env);
    restore();
    assert.deepEqual(result, { sent: 1, checked: 1 });
    assert.equal(pushes[0]!.title, "Upcoming: Intro");
    assert.match(pushes[0]!.body, /10 min/);
    assert.deepEqual(pushes[0]!.data, {
      bookingUid: "bk-1",
      action: "booking.reminder",
      offsetMin: "10",
    });
  } finally {
    close();
  }
});

test("runReminderSweep no-ops without configuration", async () => {
  const { db, close } = await openTestDb();
  try {
    const result = await runReminderSweep(db, {});
    assert.deepEqual(result, { sent: 0, checked: 0 });
  } finally {
    close();
  }
});

test("bookingEventPush soft-fails on unknown uid and without configuration", async () => {
  resetFcmAuth();
  const sa = await makeServiceAccount();
  const env = testEnv(sa.raw);
  const { db, close } = await openTestDb();
  try {
    await bookingEventPush(db, env, "missing-uid", "booking.created");
    await bookingEventPush(db, {}, "missing-uid", "booking.created");
  } finally {
    close();
  }
});
