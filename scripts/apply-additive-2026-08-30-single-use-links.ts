// One-off additive migration (2026-08-30): single-use booking links table.
// Same idempotent pattern as apply-additive-2026-08-29-auth.ts: "already
// exists" failures are treated as applied.
//
// Run: TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npx tsx apply-additive-2026-08-30-single-use-links.ts
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
if (!url || url.startsWith("file:") || url.startsWith("sqlite:")) {
  throw new Error("Set TURSO_DATABASE_URL to a LibSQL/Turso instance (not a file path).");
}
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

const statements: string[] = [
  `CREATE TABLE IF NOT EXISTS single_use_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    event_type_id INTEGER NOT NULL REFERENCES event_types(id),
    created_by_user_id INTEGER NOT NULL REFERENCES users(id),
    created_utc TEXT NOT NULL,
    expires_utc TEXT,
    used_booking_id INTEGER REFERENCES bookings(id),
    used_utc TEXT,
    revoked_utc TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS single_use_links_event_type_idx ON single_use_links(event_type_id)",
];

let applied = 0;
let skipped = 0;
for (const stmt of statements) {
  try {
    await client.execute(stmt);
    applied++;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("already exists")) skipped++;
    else throw e;
  }
}
console.log(`single-use-links migration: applied=${applied} skipped=${skipped}`);
