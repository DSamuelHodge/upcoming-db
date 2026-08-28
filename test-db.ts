import { randomUUID } from "crypto";
import { unlinkSync } from "fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const DDL = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    metadata TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    timezone TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX schedules_user_unique ON schedules(user_id)`,
  `CREATE TABLE availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    day_of_week INTEGER,
    date_override TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
  )`,
  `CREATE TABLE event_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    slug TEXT NOT NULL,
    length_minutes INTEGER NOT NULL,
    slot_interval_minutes INTEGER,
    buffer_before INTEGER NOT NULL DEFAULT 0,
    buffer_after INTEGER NOT NULL DEFAULT 0,
    scheduling_type TEXT NOT NULL DEFAULT 'individual',
    locations TEXT NOT NULL DEFAULT '[]',
    min_booking_notice INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE event_type_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type_id INTEGER NOT NULL REFERENCES event_types(id),
    host_user_id INTEGER NOT NULL REFERENCES users(id),
    priority INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX event_type_host_unique ON event_type_hosts(event_type_id, host_user_id)`,
  `CREATE TABLE bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    event_type_id INTEGER NOT NULL REFERENCES event_types(id),
    host_user_id INTEGER NOT NULL REFERENCES users(id),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    buffer_before INTEGER NOT NULL DEFAULT 0,
    buffer_after INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'accepted',
    idempotency_key TEXT NOT NULL UNIQUE,
    location TEXT
  )`,
  `CREATE TABLE booking_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    host_user_id INTEGER NOT NULL REFERENCES users(id)
  )`,
  `CREATE TABLE attendees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    email TEXT NOT NULL,
    name TEXT,
    timezone TEXT,
    phone TEXT
  )`,
  `CREATE TABLE host_mutexes (
    host_user_id INTEGER PRIMARY KEY REFERENCES users(id)
  )`,
  `CREATE TABLE host_occupancy_ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_user_id INTEGER NOT NULL REFERENCES users(id),
    tick INTEGER NOT NULL,
    booking_id INTEGER NOT NULL REFERENCES bookings(id)
  )`,
  `CREATE UNIQUE INDEX host_occupancy_tick_unique ON host_occupancy_ticks(host_user_id, tick)`,
];

export async function openTestDb(): Promise<{ db: TestDb; url: string; file: string; close: () => void }> {
  const file = `booking-test-${randomUUID()}.db`;
  const url = `file:${file}`;
  const client = createClient({ url });
  await configureConnection(client);
  for (const stmt of DDL) {
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
