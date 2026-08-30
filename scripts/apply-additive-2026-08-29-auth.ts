// One-off additive migration (2026-08-29): JWT auth — users.password_hash and
// the sessions table. Same idempotent pattern as apply-additive-2026-08-28.ts:
// "duplicate column name"/"already exists" failures are treated as applied.
//
// Run: TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… npx tsx apply-additive-2026-08-29-auth.ts
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
if (!url || url.startsWith("file:") || url.startsWith("sqlite:")) {
  throw new Error("Set TURSO_DATABASE_URL to a LibSQL/Turso instance (not a file path).");
}
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

const statements: string[] = [
  "ALTER TABLE users ADD COLUMN password_hash TEXT",
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    refresh_token_hash TEXT NOT NULL,
    expires_utc TEXT NOT NULL,
    created_utc TEXT NOT NULL,
    revoked_utc TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)",
];

let applied = 0;
let skipped = 0;
for (const stmt of statements) {
  try {
    await client.execute(stmt);
    applied++;
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("duplicate column name") || msg.includes("already exists")) skipped++;
    else throw e;
  }
}
console.log(`auth migration: applied=${applied} skipped=${skipped}`);
client.close();
