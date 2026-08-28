// One-off additive migration (2026-08-28): app-facing columns for the Android
// client (Phase 1 of the Turso/Android integration plan).
//
// `CREATE TABLE IF NOT EXISTS` never upgrades existing tables, so live
// instances need explicit ADD COLUMN statements. This script is idempotent:
// "duplicate column name" failures are treated as already-applied.
//
// Run: LIBSQL_URL=libsql://… TURSO_AUTH_TOKEN=… npx tsx apply-additive-2026-08-28.ts
import { createClient } from "@libsql/client";

function requireLibsqlUrl(): string {
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (!url) {
    throw new Error(
      "Set TURSO_DATABASE_URL (libsql://…turso.io) or LIBSQL_URL (http://host:port). SQLite file paths are rejected."
    );
  }
  if (url.startsWith("file:") || url.startsWith("sqlite:") || /\.db(\b|$)/.test(url)) {
    throw new Error(
      `Refusing SQLite file URL (${url}). Use a LibSQL/Turso instance: libsql://… or http(s)://…`
    );
  }
  return url;
}

const url = requireLibsqlUrl();
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

// Mirrors schema.ts/schema.sql exactly. Every statement is additive.
const statements: Array<[string, string]> = [
  ["users", "ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''"],
  ["users", "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN title TEXT NOT NULL DEFAULT ''"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN description TEXT NOT NULL DEFAULT ''"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN price_in_cents INTEGER NOT NULL DEFAULT 0"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd'"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN color_hex TEXT NOT NULL DEFAULT '#CC785C'"],
  ["event_types", "ALTER TABLE event_types ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1"],
  ["bookings", "ALTER TABLE bookings ADD COLUMN paid INTEGER NOT NULL DEFAULT 0"],
  ["bookings", "ALTER TABLE bookings ADD COLUMN payment_intent_id TEXT"],
  ["bookings", "ALTER TABLE bookings ADD COLUMN created_at TEXT"],
  ["attendees", "ALTER TABLE attendees ADD COLUMN notes TEXT"],
];

let applied = 0;
let skipped = 0;
for (const [table, stmt] of statements) {
  try {
    await client.execute(stmt);
    applied++;
    console.log(`applied: ${stmt}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(message)) {
      skipped++;
      console.log(`skipped (already applied): ${table} :: ${stmt}`);
    } else {
      await client.close();
      throw err;
    }
  }
}

console.log(`Done on ${url}: ${applied} applied, ${skipped} skipped.`);
await client.close();
