// One-time seed for the live upcoming-db-v2 instance: mirrors the Android
// app's demo data (user Alex Rivera, weekly hours, four event types).
//
// Run: TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npx tsx seed-live.ts
import { createClient } from "@libsql/client";

function requireLibsqlUrl(): string {
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (!url || url.startsWith("file:")) {
    throw new Error("Set TURSO_DATABASE_URL to a live libsql:// instance");
  }
  return url;
}

const url = requireLibsqlUrl();
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

const existing = await client.execute("SELECT COUNT(*) AS n FROM users");
if (Number(existing.rows[0].n) > 0) {
  console.log("users table not empty — skipping seed");
  await client.close();
  process.exit(0);
}

await client.execute(
  `INSERT INTO users (email, username, timezone, metadata, display_name, avatar_url) VALUES
   ('alex.rivera@upcoming.io', 'alex', 'America/New_York',
    '{"role":"Product Lead","company":"Upcoming Labs"}',
    'Alex Rivera',
    'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150')`
);
const userId = Number(
  (await client.execute("SELECT id FROM users WHERE username = 'alex'")).rows[0].id
);

await client.execute(
  `INSERT INTO schedules (user_id, name, timezone) VALUES (${userId}, 'Working Hours', 'America/New_York')`
);
const scheduleId = Number(
  (await client.execute("SELECT id FROM schedules WHERE user_id = ?", [userId])).rows[0].id
);

// Mon–Fri 09:00–17:00 recurring rules
for (let day = 1; day <= 5; day++) {
  await client.execute({
    sql: "INSERT INTO availability (schedule_id, day_of_week, date_override, start_time, end_time) VALUES (?, ?, NULL, '09:00', '17:00')",
    args: [scheduleId, day],
  });
}

const eventTypes: Array<[string, string, string, number, number, string, string]> = [
  // slug, title, description, minutes, priceCents, colorHex, locations
  ["15min", "15 Min Discovery Call",
    "Quick informal sync to discuss product requirements, scope, and synergy.",
    15, 0, "#CC785C",
    '[{"type":"integrations:daily","label":"Daily Video Call"}]'],
  ["demo-30m", "30 Min Product Walkthrough",
    "Comprehensive walkthrough of the Upcoming booking engine and multi-host scheduling.",
    30, 0, "#5DB8A6",
    '[{"type":"integrations:daily","label":"Daily Video Call"},{"type":"userPhone","label":"Phone Call"}]'],
  ["deep-dive", "45 Min Technical Deep Dive",
    "Architecture consulting & system review. Requires Stripe payment deposit.",
    45, 7500, "#5B8DB8",
    '[{"type":"integrations:daily","label":"Daily Video Call"}]'],
  ["strategy-collective", "60 Min Strategy (Collective)",
    "Joint session with the team for end-to-end technical strategy.",
    60, 15000, "#E8A55A",
    '[{"type":"integrations:daily","label":"Daily Video Call"}]'],
];

for (const [i, [slug, title, description, minutes, price, colorHex, locations]] of eventTypes.entries()) {
  const schedulingType = slug === "strategy-collective" ? "collective" : "individual";
  const res = await client.execute({
    sql: `INSERT INTO event_types
          (owner_user_id, slug, length_minutes, buffer_before, buffer_after, scheduling_type,
           locations, min_booking_notice, title, description, price_in_cents, currency, color_hex, is_active)
          VALUES (?, ?, ?, 0, 0, ?, ?, 60, ?, ?, ?, 'usd', ?, 1)`,
    args: [userId, slug, minutes, schedulingType, locations, title, description, price, colorHex],
  });
  const eventTypeId = Number(res.lastInsertRowid);
  await client.execute({
    sql: "INSERT INTO event_type_hosts (event_type_id, host_user_id, priority) VALUES (?, ?, 0)",
    args: [eventTypeId, userId],
  });
  console.log(`seeded event type ${i + 1}: ${title}`);
}

console.log(`Seed complete on ${url}: user 'alex' (id ${userId}), schedule ${scheduleId}, ${eventTypes.length} event types.`);
await client.close();
