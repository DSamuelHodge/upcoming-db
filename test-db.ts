import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { schemaStatements } from "./schema-sql";
import * as schema from "./schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export async function openTestDb(): Promise<{ db: TestDb; url: string; file: string; close: () => void }> {
  const file = `booking-test-${randomUUID()}.db`;
  const url = `file:${file}`;
  const client = createClient({ url });
  await configureConnection(client);
  // Apply the same artifact production applies (schema.sql), so tests exercise
  // the real indexes/constraints — e.g. event_type_owner_slug_unique — instead
  // of a hand-written approximation that can drift.
  for (const stmt of schemaStatements()) {
    await client.execute(stmt);
  }
  const db = drizzle(client, { schema });
  return {
    db,
    url,
    file,
    close: () => {
      client.close();
      try {
        unlinkSync(file);
        unlinkSync(`${file}-wal`);
        unlinkSync(`${file}-shm`);
      } catch {
        // ignore missing wal/shm
      }
    },
  };
}

export async function openDb(url: string): Promise<{ db: TestDb; client: Client }> {
  const client = createClient({ url });
  await configureConnection(client);
  return { db: drizzle(client, { schema }), client };
}

export async function configureConnection(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 250");
}
