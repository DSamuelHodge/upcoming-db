-- Applied over LibSQL HTTP / libsql:// (Turso or sqld). Not a sqlite3 file open.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS schedules_user_unique ON schedules(user_id);

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL REFERENCES schedules(id),
  day_of_week INTEGER,
  date_override TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS availability_schedule_idx ON availability(schedule_id);

CREATE TABLE IF NOT EXISTS event_types (
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
);
CREATE UNIQUE INDEX IF NOT EXISTS event_type_owner_slug_unique ON event_types(owner_user_id, slug);

CREATE TABLE IF NOT EXISTS event_type_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type_id INTEGER NOT NULL REFERENCES event_types(id),
  host_user_id INTEGER NOT NULL REFERENCES users(id),
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS event_type_host_unique ON event_type_hosts(event_type_id, host_user_id);
CREATE INDEX IF NOT EXISTS event_type_hosts_event_type_idx ON event_type_hosts(event_type_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  event_type_id INTEGER NOT NULL REFERENCES event_types(id),
  host_user_id INTEGER NOT NULL REFERENCES users(id),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  buffer_before INTEGER NOT NULL DEFAULT 0,
  buffer_after INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'accepted',
  cancelled_at TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  location TEXT
);
CREATE INDEX IF NOT EXISTS bookings_host_time_idx ON bookings(host_user_id, start_time, end_time);

CREATE TABLE IF NOT EXISTS host_occupancy_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_user_id INTEGER NOT NULL REFERENCES users(id),
  tick INTEGER NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS host_occupancy_tick_unique ON host_occupancy_ticks(host_user_id, tick);
CREATE INDEX IF NOT EXISTS host_occupancy_ticks_booking_idx ON host_occupancy_ticks(booking_id);

CREATE TABLE IF NOT EXISTS booking_hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  host_user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_host_unique ON booking_hosts(booking_id, host_user_id);

CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  email TEXT NOT NULL,
  name TEXT,
  timezone TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  encrypted_token TEXT NOT NULL
);
