// One-time demo-bookings seed for live upcoming-db-v2 — gives the Android
// dashboard's Performance Metrics real data (Upcoming 2, Hours 2.0, $225).
// Upcoming bookings get host_occupancy_ticks rows so the tick-index conflict
// backstop stays authoritative (raw SQL must honor the handler's invariants).
//
// Run: TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npx tsx seed-bookings.ts
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
if (!url || url.startsWith("file:")) throw new Error("Set TURSO_DATABASE_URL to a live libsql:// instance");
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

const HOST_USER_ID = 38;

type Seed = {
  uid: string;
  eventTypeId: number;
  startUtc: string;
  endUtc: string;
  status: "accepted";
  paid: boolean;
  location: string;
  attendee: [string, string, string];
  withTicks: boolean;
};

const seeds: Seed[] = [
  {
    uid: "demo-upcoming-paid-001",
    eventTypeId: 40, // deep-dive, $75
    startUtc: "2026-09-02T13:00:00.000Z",
    endUtc: "2026-09-02T13:45:00.000Z",
    status: "accepted",
    paid: true,
    location: JSON.stringify({ type: "integrations:daily", label: "Daily Video Call", url: "https://upcoming.daily.co/demo-upcoming-paid-001" }),
    attendee: ["client@acmecorp.test", "Jordan Blake", "America/New_York"],
    withTicks: true,
  },
  {
    uid: "demo-upcoming-free-001",
    eventTypeId: 38, // 15min discovery
    startUtc: "2026-09-03T14:00:00.000Z",
    endUtc: "2026-09-03T14:15:00.000Z",
    status: "accepted",
    paid: false,
    location: JSON.stringify({ type: "integrations:daily", label: "Daily Video Call", url: "https://upcoming.daily.co/demo-upcoming-free-001" }),
    attendee: ["pri@northwind.test", "Priya Nair", "America/New_York"],
    withTicks: true,
  },
  {
    uid: "demo-past-collective-001",
    eventTypeId: 41, // strategy-collective, $150
    startUtc: "2026-08-20T14:00:00.000Z",
    endUtc: "2026-08-20T15:00:00.000Z",
    status: "accepted",
    paid: true,
    location: JSON.stringify({ type: "integrations:daily", label: "Daily Video Call", url: "https://upcoming.daily.co/demo-past-collective-001" }),
    attendee: ["cto@vertexlabs.test", "Marcus Webb", "America/New_York"],
    withTicks: false, // past — no occupancy needed
  },
];

const iso = (utc: string) => new Date(utc).toISOString();

for (const s of seeds) {
  const exists = await client.execute({ sql: "SELECT 1 FROM bookings WHERE uid = ?", args: [s.uid] });
  if (exists.rows.length > 0) {
    console.log(`skip (exists): ${s.uid}`);
    continue;
  }
  await client.execute({
    sql: `INSERT INTO bookings
          (uid, event_type_id, host_user_id, start_time, end_time, buffer_before, buffer_after,
           status, idempotency_key, location, paid, created_at)
          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`,
    args: [
      s.uid, s.eventTypeId, HOST_USER_ID,
      iso(s.startUtc), iso(s.endUtc),
      s.status,
      `seed-${s.uid}`,
      s.location,
      s.paid ? 1 : 0,
      new Date().toISOString(),
    ],
  });
  const bookingId = Number(
    (await client.execute({ sql: "SELECT id FROM bookings WHERE uid = ?", args: [s.uid] })).rows[0].id
  );
  await client.execute({
    sql: "INSERT INTO attendees (booking_id, email, name, timezone) VALUES (?, ?, ?, ?)",
    args: [bookingId, s.attendee[0], s.attendee[1], s.attendee[2]],
  });
  if (s.withTicks) {
    const startMs = new Date(s.startUtc).getTime();
    const endMs = new Date(s.endUtc).getTime();
    for (let t = startMs; t < endMs; t += 60_000) {
      await client.execute({
        sql: "INSERT OR IGNORE INTO host_occupancy_ticks (host_user_id, tick, booking_id) VALUES (?, ?, ?)",
        args: [HOST_USER_ID, Math.floor(t / 60_000), bookingId],
      });
    }
  }
  console.log(`seeded booking: ${s.uid} (id ${bookingId})`);
}

console.log("Demo bookings seed complete.");
await client.close();
