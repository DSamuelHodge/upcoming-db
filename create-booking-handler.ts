import { randomUUID } from "crypto";
import { and, eq, gt, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { DateTime } from "luxon";
import { z } from "zod";
import { createDailyRoom, deleteDailyRoom } from "./daily";
import { sendBookingConfirmation, type ChosenLocation } from "./notifications";
import {
  AvailabilityRepository,
  computeAvailability,
  EventType as EngineEventType,
  ExistingBooking,
  Schedule,
} from "./availability-engine";
import { EventTypeNotFoundError, loadEventType, LoadedEventType, SchemaClient } from "./event-types";
import { InvalidJsonColumnError, parseLocationsColumn } from "./json-columns";
import { logWarn } from "./logger";
import { assignRoundRobinHost, HostLoadRepository } from "./multi-host-routing";
import * as schema from "./schema";
import { attendees, availability, bookingHosts, bookings, hostOccupancyTicks, schedules, singleUseLinks } from "./schema";

export { EventTypeNotFoundError };

type AppDb = LibSQLDatabase<typeof schema>;
type Executor = Pick<AppDb, "select" | "insert"> & SchemaClient;

export const CreateBookingInput = z.object({
  eventTypeId: z.number().int(),
  slotStartUtc: z.string().datetime({ offset: true }),
  slotEndUtc: z.string().datetime({ offset: true }),
  location: z
    .object({ type: z.enum(["integrations:daily", "inPerson", "userPhone"]) })
    .passthrough(),
  attendee: z.object({
    email: z.string().email(),
    name: z.string().optional(),
    timezone: z.string().optional(),
    phone: z.string().optional(),
  }),
  idempotencyKey: z.string().min(1),
  // Optional Calendly-style single-use link token (?lid=...). When present it
  // must reference an unused, unrevoked, unexpired link for this event type;
  // the link is burned atomically inside the booking transaction.
  singleUseToken: z.string().min(8).max(128).optional(),
});
export type CreateBookingInput = z.infer<typeof CreateBookingInput>;

export interface BookingResult {
  uid: string;
  eventTypeId: number;
  hostUserId: number;
  attendingHostUserIds: number[];
  startUtc: string;
  endUtc: string;
  status: "pending" | "accepted" | "cancelled" | "rejected";
  replay?: boolean;
  location: ChosenLocation;
  attendee: { email: string; name?: string | null; phone?: string | null };
}

export class SlotConflictError extends Error {
  readonly statusCode = 409 as const;
}

/** A booking arrived carrying a single-use link token that cannot be used:
 *  unknown token, wrong event type, already used, revoked, or expired. */
export class SingleUseLinkError extends Error {
  readonly statusCode = 409 as const;
}

export class LocationNotOfferedError extends Error {
  readonly statusCode = 400 as const;
}

export class BookingNotFoundError extends Error {
  readonly statusCode = 404 as const;
}

export type CancelBookingInput = {
  /** Public booking id. */
  uid?: string;
  /** Caller's idempotency key (from the original booking request). */
  idempotencyKey?: string;
};

export type HttpErrorMapping = { status: number; message: string };

/**
 * Contract for the HTTP layer: map handler errors to responses.
 * - 409 SlotConflictError (slot taken / not on grid / out of hours)
 * - 404 BookingNotFoundError (cancellation of unknown booking)
 * - 400 LocationNotOfferedError and request-validation failures (ZodError)
 * - anything else, including InvalidJsonColumnError and internal faults:
 *   500 with a generic message — internal error text is never leaked to clients.
 */
export function mapErrorToHttp(err: unknown): HttpErrorMapping {
  if (err instanceof SlotConflictError) return { status: err.statusCode, message: err.message };
  if (err instanceof SingleUseLinkError) return { status: err.statusCode, message: err.message };
  if (err instanceof BookingNotFoundError) return { status: err.statusCode, message: err.message };
  if (err instanceof LocationNotOfferedError) return { status: err.statusCode, message: err.message };
  if (err instanceof z.ZodError) {
    const detail = err.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { status: 400, message: `Invalid request: ${detail}` };
  }
  return { status: 500, message: "Internal server error" };
}

const ACTIVE_BOOKING_STATUSES = ["pending", "accepted"] as const;

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : "";
  return `${err.message} ${cause}`;
}

/**
 * Fixed window handed to the availability engine for the working-hours,
 * min-notice, and slot-alignment checks. Covers any local-day boundary
 * (UTC offsets run ±14h) plus overnight windows spilling into the next day.
 * Conflicts with other bookings' snapshotted buffers are checked exactly in
 * SQL by bufferedOverlapExists and do NOT depend on this window's width.
 */
const ENGINE_CHECK_WINDOW_HOURS = 48;

// A booking's conflict footprint is [start - bufferBefore, end + bufferAfter]
// using ITS OWN snapshotted buffers. No fixed window can be wide enough for
// arbitrary buffers, so expand each candidate booking's span in SQL instead.
function bufferedOverlapCondition(slotStartUtc: string, slotEndUtc: string) {
  return and(
    sql`datetime(${bookings.endTime}, '+' || MAX(${bookings.bufferAfter}, 0) || ' minutes') > datetime(${slotStartUtc})`,
    sql`datetime(${bookings.startTime}, '-' || MAX(${bookings.bufferBefore}, 0) || ' minutes') < datetime(${slotEndUtc})`
  );
}

async function bufferedOverlapExists(
  tx: Executor,
  hostUserId: number,
  slotStartUtc: string,
  slotEndUtc: string
): Promise<boolean> {
  const overlap = bufferedOverlapCondition(slotStartUtc, slotEndUtc);
  const active = inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]);

  const asPrimary = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.hostUserId, hostUserId), active, overlap))
    .limit(1);
  if (asPrimary.length > 0) return true;

  const asSecondary = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(bookingHosts, eq(bookingHosts.bookingId, bookings.id))
    .where(and(eq(bookingHosts.hostUserId, hostUserId), active, overlap))
    .limit(1);
  return asSecondary.length > 0;
}

async function isHostFree(
  tx: Executor,
  repo: AvailabilityRepository,
  eventType: LoadedEventType,
  hostUserId: number,
  slotStartUtc: string,
  slotEndUtc: string
): Promise<boolean> {
  if (await bufferedOverlapExists(tx, hostUserId, slotStartUtc, slotEndUtc)) {
    return false;
  }

  const rangeStart = DateTime.fromISO(slotStartUtc, { zone: "utc" }).minus({
    hours: ENGINE_CHECK_WINDOW_HOURS,
  });
  const rangeEnd = DateTime.fromISO(slotEndUtc, { zone: "utc" }).plus({
    hours: ENGINE_CHECK_WINDOW_HOURS,
  });
  if (!rangeStart.isValid || !rangeEnd.isValid) {
    throw new Error(`Invalid slot bounds: ${slotStartUtc}–${slotEndUtc}`);
  }

  const slots = await computeAvailability(repo, {
    userId: hostUserId,
    eventTypeId: eventType.id,
    rangeStartUtc: rangeStart.toISO()!,
    rangeEndUtc: rangeEnd.toISO()!,
  });

  const target = DateTime.fromISO(slotStartUtc, { zone: "utc" });
  const targetEnd = DateTime.fromISO(slotEndUtc, { zone: "utc" });
  return slots.some(
    (s) =>
      DateTime.fromISO(s.startUtc, { zone: "utc" }).equals(target) &&
      DateTime.fromISO(s.endUtc, { zone: "utc" }).equals(targetEnd)
  );
}

async function assertHostStillFree(
  tx: Executor,
  repo: AvailabilityRepository,
  eventType: LoadedEventType,
  hostUserId: number,
  slotStartUtc: string,
  slotEndUtc: string
): Promise<void> {
  if (!(await isHostFree(tx, repo, eventType, hostUserId, slotStartUtc, slotEndUtc))) {
    throw new SlotConflictError(`Host ${hostUserId} is no longer available for ${slotStartUtc}–${slotEndUtc}`);
  }
}

function toUtcIso(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: "utc" });
  if (!dt.isValid) {
    throw new Error(`Invalid UTC instant: ${iso}`);
  }
  return dt.toUTC().toISO()!;
}

/** Repository over an Executor (drizzle db or tx). Exported for the HTTP
 *  layer's read/availability endpoints; named `tx` for the handler's own
 *  transactional usage. */
export function makeTxRepository(tx: Executor): AvailabilityRepository & HostLoadRepository {
  return {
    async getSchedule(userId: number): Promise<Schedule> {
      const [schedule] = await tx.select().from(schedules).where(eq(schedules.userId, userId)).limit(1);
      if (!schedule) {
        throw new Error(`No schedule found for user ${userId}`);
      }
      const rules = await tx.select().from(availability).where(eq(availability.scheduleId, schedule.id));
      return {
        timezone: schedule.timezone,
        availability: rules.map((r) => ({
          dayOfWeek: r.dayOfWeek,
          dateOverride: r.dateOverride,
          startTime: r.startTime,
          endTime: r.endTime,
        })),
      };
    },

    async getEventType(eventTypeId: number): Promise<EngineEventType> {
      const loaded = await loadEventType(tx, eventTypeId);
      return {
        lengthMinutes: loaded.lengthMinutes,
        bufferBefore: loaded.bufferBefore,
        bufferAfter: loaded.bufferAfter,
        minBookingNoticeMinutes: loaded.minBookingNoticeMinutes,
        slotIntervalMinutes: loaded.slotIntervalMinutes,
      };
    },

    async getBookingsInRange(userId: number, startUtc: string, endUtc: string): Promise<ExistingBooking[]> {
      const overlapAndActive = and(
        inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES]),
        lt(bookings.startTime, endUtc),
        gt(bookings.endTime, startUtc)
      );

      const asPrimary = await tx
        .select({
          startTimeUtc: bookings.startTime,
          endTimeUtc: bookings.endTime,
          bufferBefore: bookings.bufferBefore,
          bufferAfter: bookings.bufferAfter,
        })
        .from(bookings)
        .where(and(eq(bookings.hostUserId, userId), overlapAndActive));

      const asSecondary = await tx
        .select({
          startTimeUtc: bookings.startTime,
          endTimeUtc: bookings.endTime,
          bufferBefore: bookings.bufferBefore,
          bufferAfter: bookings.bufferAfter,
        })
        .from(bookings)
        .innerJoin(bookingHosts, eq(bookingHosts.bookingId, bookings.id))
        .where(and(eq(bookingHosts.hostUserId, userId), overlapAndActive));

      return [...asPrimary, ...asSecondary];
    },

    async getLastAssignedAt(hostUserIds: number[], eventTypeId: number) {
      const result = new Map<number, string | null>();
      for (const id of hostUserIds) result.set(id, null);
      if (hostUserIds.length === 0) return result;

      const rows = await tx
        .select({
          hostUserId: bookings.hostUserId,
          last: max(bookings.startTime),
        })
        .from(bookings)
        .where(
          and(
            eq(bookings.eventTypeId, eventTypeId),
            inArray(bookings.hostUserId, hostUserIds),
            inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])
          )
        )
        .groupBy(bookings.hostUserId);

      for (const row of rows) {
        result.set(row.hostUserId, row.last ?? null);
      }
      return result;
    },
  };
}

type ViolatedConstraint = "idempotency_key" | "host_slot" | "other";

function classifyUniqueViolation(err: unknown): ViolatedConstraint {
  const message = errorText(err);
  if (!/UNIQUE constraint failed/i.test(message)) return "other";
  if (message.includes("idempotency_key")) return "idempotency_key";
  if (message.includes("host_occupancy_tick_unique")) return "host_slot";
  if (/host_occupancy_ticks\.host_user_id,\s*host_occupancy_ticks\.tick/.test(message)) return "host_slot";
  if (message.includes("host_slot_lock_unique") || message.includes("host_slot_unique")) return "host_slot";
  return "other";
}

const OCCUPANCY_TICK_MS = 60_000;

function occupancyTicks(
  startUtc: string,
  endUtc: string,
  bufferBefore: number,
  bufferAfter: number
): number[] {
  const start = DateTime.fromISO(startUtc, { zone: "utc" }).minus({
    minutes: Math.max(0, bufferBefore),
  });
  const end = DateTime.fromISO(endUtc, { zone: "utc" }).plus({
    minutes: Math.max(0, bufferAfter),
  });
  const from = Math.floor(start.toMillis() / OCCUPANCY_TICK_MS);
  const to = Math.floor(end.toMillis() / OCCUPANCY_TICK_MS);
  const ticks: number[] = [];
  for (let tick = from; tick < to; tick++) ticks.push(tick);
  return ticks;
}

async function insertOccupancyTicks(
  tx: Executor,
  hostUserIds: number[],
  bookingId: number,
  startUtc: string,
  endUtc: string,
  bufferBefore: number,
  bufferAfter: number
): Promise<void> {
  const ticks = occupancyTicks(startUtc, endUtc, bufferBefore, bufferAfter);
  const hosts = [...new Set(hostUserIds)].sort((a, b) => a - b);
  const rows = hosts.flatMap((hostUserId) => ticks.map((tick) => ({ hostUserId, tick, bookingId })));
  if (rows.length === 0) return;
  await tx.insert(hostOccupancyTicks).values(rows);
}

async function replayExistingBooking(db: AppDb, idempotencyKey: string): Promise<BookingResult | null> {
  const [existing] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, idempotencyKey)).limit(1);
  if (!existing) return null;

  const extras = await db
    .select({ hostUserId: bookingHosts.hostUserId })
    .from(bookingHosts)
    .where(eq(bookingHosts.bookingId, existing.id));

  const attendingHostUserIds = [
    existing.hostUserId,
    ...extras.map((row) => row.hostUserId).filter((id) => id !== existing.hostUserId),
  ];

  const [att] = await db.select().from(attendees).where(eq(attendees.bookingId, existing.id)).limit(1);
  return bookingToResult(
    existing,
    attendingHostUserIds,
    { email: att?.email ?? "", name: att?.name ?? null, phone: att?.phone ?? null },
    true
  );
}

function isSqliteBusy(err: unknown): boolean {
  return /SQLITE_BUSY|database is locked/i.test(errorText(err));
}

function bookingToResult(
  row: typeof schema.bookings.$inferSelect,
  attendingHostUserIds: number[],
  attendee: { email: string; name?: string | null; phone?: string | null },
  replay: boolean
): BookingResult {
  let location: ChosenLocation;
  try {
    location = row.location
      ? (JSON.parse(row.location) as ChosenLocation)
      : ({ type: "inPerson" } as ChosenLocation);
  } catch {
    location = { type: "inPerson" } as ChosenLocation;
  }
  return {
    uid: row.uid,
    eventTypeId: row.eventTypeId,
    hostUserId: row.hostUserId,
    attendingHostUserIds,
    startUtc: row.startTime,
    endUtc: row.endTime,
    status: row.status,
    replay,
    location,
    attendee,
  };
}

/**
 * Cancels a booking in one transaction: stamps status + cancelled_at, then
 * removes the booking's occupancy ticks and secondary-host rows so the slot's
 * availability footprint disappears atomically. Idempotent — cancelling an
 * already-cancelled booking returns its current state (replay: true) instead
 * of failing. Ticks must be pruned here: unique (host, tick) rows are the
 * availability backstop, and orphaned ticks would block the slot forever.
 */
export async function cancelBookingHandler(db: AppDb, rawInput: CancelBookingInput): Promise<BookingResult> {
  if (!rawInput.uid && !rawInput.idempotencyKey) {
    throw new Error("cancelBookingHandler requires uid or idempotencyKey");
  }

  const result = await db.transaction(async (tx) => {
    const match = rawInput.uid
      ? eq(bookings.uid, rawInput.uid)
      : eq(bookings.idempotencyKey, rawInput.idempotencyKey!);

    const [existing] = await tx.select().from(bookings).where(match).limit(1);
    if (!existing) {
      throw new BookingNotFoundError(`No booking found for ${rawInput.uid ? `uid ${rawInput.uid}` : "the given idempotency key"}`);
    }

    const extras = await tx
      .select({ hostUserId: bookingHosts.hostUserId })
      .from(bookingHosts)
      .where(eq(bookingHosts.bookingId, existing.id));
    const [att] = await tx.select().from(attendees).where(eq(attendees.bookingId, existing.id)).limit(1);
    const attendee = { email: att?.email ?? "", name: att?.name ?? null, phone: att?.phone ?? null };

    if (existing.status === "cancelled") {
      return bookingToResult(
        existing,
        [existing.hostUserId, ...extras.map((r) => r.hostUserId).filter((id) => id !== existing.hostUserId)],
        attendee,
        true
      );
    }

    const cancelledAt = new Date().toISOString();
    await tx
      .update(bookings)
      .set({ status: "cancelled", cancelledAt })
      .where(and(eq(bookings.id, existing.id), inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])));

    await tx.delete(hostOccupancyTicks).where(eq(hostOccupancyTicks.bookingId, existing.id));
    await tx.delete(bookingHosts).where(eq(bookingHosts.bookingId, existing.id));

    return bookingToResult(
      { ...existing, status: "cancelled", cancelledAt },
      [existing.hostUserId],
      attendee,
      false
    );
  });

  // Best-effort teardown of a MINTED per-booking room. Pre-configured rooms
  // never carry dailyRoomName, and replays were already torn down on the
  // first cancel — both are skipped here. Rooms also self-expire via nbf/exp,
  // so a teardown failure only leaves the join window open until exp.
  const roomName = result.location.dailyRoomName;
  if (!result.replay && typeof roomName === "string" && roomName.length > 0) {
    const deleted = await deleteDailyRoom(roomName);
    if (!deleted) {
      logWarn("daily_room_teardown_incomplete", { uid: result.uid, roomName });
    }
  }
  return result;
}

/** Safety net: ticks whose booking row is gone would block a host's slot forever. */
export async function findOrphanedTicks(
  db: AppDb
): Promise<Array<{ tickId: number; bookingId: number; hostUserId: number }>> {
  const rows = await db
    .select({
      tickId: hostOccupancyTicks.id,
      bookingId: hostOccupancyTicks.bookingId,
      hostUserId: hostOccupancyTicks.hostUserId,
    })
    .from(hostOccupancyTicks)
    .leftJoin(bookings, eq(bookings.id, hostOccupancyTicks.bookingId))
    .where(isNull(bookings.id));
  return rows;
}

/**
 * Resolves the booking's chosen location BEFORE the write transaction opens:
 * 1. a pre-configured `url` on the event type's menu entry wins — used
 *    verbatim, never minted, never torn down (it is a shared permanent room);
 * 2. else DAILY_DEFAULT_ROOM_URL, if set;
 * 3. else a per-booking room is minted (name = uid, join window = slot ±
 *    grace). Mint failure soft-fails: the booking proceeds with
 *    "link to follow" and the failure is logged.
 * The menu read + validation happening outside the tx is safe: the menu is
 * presentation config, not conflict data — conflict correctness lives in the
 * tick index and the buffered-overlap check inside the transaction.
 * Minting before the tx keeps the Daily API round-trip out of the write lock.
 */
async function resolveChosenLocation(
  db: AppDb,
  input: CreateBookingInput,
  uid: string,
  slotStartUtc: string,
  slotEndUtc: string
): Promise<ChosenLocation> {
  const [etRow] = await db
    .select({ locations: schema.eventTypes.locations })
    .from(schema.eventTypes)
    .where(eq(schema.eventTypes.id, input.eventTypeId))
    .limit(1);
  const menu = parseLocationsColumn(etRow?.locations);
  const menuEntry = menu.find((m) => m.type === input.location.type);
  if (!menuEntry) {
    throw new LocationNotOfferedError(
      `location type ${input.location.type} is not offered by event type ${input.eventTypeId}`,
    );
  }
  // Strip a menu-provided dailyRoomName: only rooms minted for THIS booking
  // may be torn down at cancel time — a shared/permanent room must never be
  // deleted because its menu JSON happened to carry the field.
  const { dailyRoomName: _menuRoomName, ...menuRest } = menuEntry;
  const chosen: ChosenLocation = { ...menuRest };
  if (input.location.type !== "integrations:daily") return chosen;

  if (typeof chosen.url === "string" && chosen.url.length > 0) {
    return chosen;
  }
  const defaultRoom = process.env.DAILY_DEFAULT_ROOM_URL;
  if (defaultRoom) return { ...chosen, url: defaultRoom };

  const nbf = Math.floor(DateTime.fromISO(slotStartUtc, { zone: "utc" }).toMillis() / 1000);
  const graceSeconds = Number(process.env.DAILY_ROOM_GRACE_SECONDS ?? 3600);
  const exp = Math.floor(DateTime.fromISO(slotEndUtc, { zone: "utc" }).toMillis() / 1000) + graceSeconds;
  const url = await createDailyRoom(uid, nbf, exp);
  if (!url) return chosen;
  // dailyRoomName marks the room as MINTED — the only kind cancel teardown deletes.
  return { ...chosen, url, dailyRoomName: uid };
}

/** Deletes the attempt's minted room when the booking was NOT persisted under it. */
async function teardownMintedRoom(chosen: ChosenLocation, uid: string): Promise<void> {
  if (typeof chosen.dailyRoomName === "string" && chosen.dailyRoomName.length > 0) {
    const deleted = await deleteDailyRoom(chosen.dailyRoomName);
    if (!deleted) {
      logWarn("daily_room_teardown_incomplete", { uid, roomName: chosen.dailyRoomName });
    }
  }
}

export async function createBookingHandler(db: AppDb, rawInput: unknown): Promise<BookingResult> {
  const input = CreateBookingInput.parse(rawInput);
  const slotStartUtc = toUtcIso(input.slotStartUtc);
  const slotEndUtc = toUtcIso(input.slotEndUtc);

  // Fast replay path: a booking that already exists under this idempotency key
  // carries its own room — return it without minting anything. (The insert-time
  // replay below still handles the race where a concurrent first request
  // commits after this check.)
  const preexisting = await replayExistingBooking(db, input.idempotencyKey);
  if (preexisting) return preexisting;

  // uid and the video room are resolved once, before any attempt: retries
  // reuse the same room name (duplicate-name recovery makes mint idempotent),
  // and no API call runs inside the write transaction.
  const uid = randomUUID();
  const chosen = await resolveChosenLocation(db, input, uid, slotStartUtc, slotEndUtc);

  const maxAttempts = 16;
  let lastErr: unknown;
  let persisted = false;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await commitBooking(db, input, uid, chosen, slotStartUtc, slotEndUtc);
        // Availability unchanged by location; only confirmation differs.
        // Fire-and-forget, but failures are logged (with uid), not swallowed.
        void sendBookingConfirmation({ result, guestPhone: result.attendee.phone ?? null }).catch((err) => {
          logWarn("booking_confirmation_failed", { uid: result.uid, error: errorText(err) });
        });
        persisted = true;
        return result;
      } catch (err) {
        lastErr = err;
        if (isSqliteBusy(err) && attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }

        const violation = classifyUniqueViolation(err);

        if (violation === "idempotency_key") {
          const existing = await replayExistingBooking(db, input.idempotencyKey);
          if (existing) return existing;
        }

        if (violation === "host_slot") {
          throw new SlotConflictError(`Slot ${slotStartUtc}–${slotEndUtc} was taken by a concurrent request`);
        }

        throw err;
      }
    }
    throw lastErr;
  } finally {
    // Any terminal path that did not persist the booking under this attempt's
    // room (replay, conflict, exhausted retries, unexpected error) must not
    // leak the minted room — it would otherwise linger until exp.
    if (!persisted) await teardownMintedRoom(chosen, uid);
  }
}

async function commitBooking(
  db: AppDb,
  input: CreateBookingInput,
  uid: string,
  chosen: ChosenLocation,
  slotStartUtc: string,
  slotEndUtc: string
): Promise<BookingResult> {
  return await db.transaction(async (tx) => {
      const eventType = await loadEventType(tx, input.eventTypeId);
      const repo = makeTxRepository(tx);

      const primaryHostId = eventType.hostUserIds[0];
      if (primaryHostId === undefined) {
        throw new EventTypeNotFoundError(`event_type ${input.eventTypeId} has no hosts configured in event_type_hosts`);
      }

      let hostUserId: number;
      let attendingHostUserIds: number[];

      if (eventType.schedulingType === "individual") {
        hostUserId = primaryHostId;
        await assertHostStillFree(tx, repo, eventType, hostUserId, slotStartUtc, slotEndUtc);
        attendingHostUserIds = [hostUserId];
      } else if (eventType.schedulingType === "collective") {
        for (const candidateId of eventType.hostUserIds) {
          await assertHostStillFree(tx, repo, eventType, candidateId, slotStartUtc, slotEndUtc);
        }
        hostUserId = primaryHostId;
        attendingHostUserIds = eventType.hostUserIds;
      } else {
        const stillFree: number[] = [];
        for (const candidateId of eventType.hostUserIds) {
          if (await isHostFree(tx, repo, eventType, candidateId, slotStartUtc, slotEndUtc)) {
            stillFree.push(candidateId);
          }
        }
        if (stillFree.length === 0) {
          throw new SlotConflictError(
            `No host remained available for event type ${input.eventTypeId} at ${slotStartUtc}`
          );
        }
        hostUserId = await assignRoundRobinHost(repo, {
          eventTypeId: input.eventTypeId,
          candidateHostUserIds: stillFree,
          slotStartUtc,
          slotEndUtc,
        });
        attendingHostUserIds = [hostUserId];
      }

      // Single-use link validation + burn, inside the same transaction as the
      // booking insert: a failed/conflicting booking never burns a link, and a
      // burned link always corresponds to a persisted booking.
      let singleUseLinkId: number | null = null;
      if (input.singleUseToken !== undefined) {
        const [link] = await tx
          .select()
          .from(singleUseLinks)
          .where(eq(singleUseLinks.token, input.singleUseToken))
          .limit(1);
        if (!link || link.eventTypeId !== input.eventTypeId) {
          throw new SingleUseLinkError("single-use link is not valid for this event type");
        }
        if (link.revokedUtc) throw new SingleUseLinkError("single-use link has been revoked");
        if (link.usedUtc) throw new SingleUseLinkError("single-use link has already been used");
        if (link.expiresUtc && new Date(link.expiresUtc).getTime() <= Date.now()) {
          throw new SingleUseLinkError("single-use link has expired");
        }
        singleUseLinkId = link.id;
      }

      const [inserted] = await tx
        .insert(bookings)
        .values({
          uid,
          eventTypeId: input.eventTypeId,
          hostUserId,
          startTime: slotStartUtc,
          endTime: slotEndUtc,
          bufferBefore: eventType.bufferBefore,
          bufferAfter: eventType.bufferAfter,
          status: "accepted",
          idempotencyKey: input.idempotencyKey,
          location: JSON.stringify(chosen),
          createdAt: DateTime.now().toUTC().toISO()!,
        })
        .returning({ id: bookings.id });

      if (!inserted) {
        throw new Error("Booking insert returned no row");
      }

      if (singleUseLinkId !== null) {
        await tx
          .update(singleUseLinks)
          .set({ usedBookingId: inserted.id, usedUtc: DateTime.now().toUTC().toISO()! })
          .where(eq(singleUseLinks.id, singleUseLinkId));
      }

      const secondaryHostIds = attendingHostUserIds.filter((id) => id !== hostUserId);
      if (eventType.schedulingType === "collective" && secondaryHostIds.length > 0) {
        await tx.insert(bookingHosts).values(
          secondaryHostIds.map((id) => ({ bookingId: inserted.id, hostUserId: id }))
        );
      }

      await insertOccupancyTicks(
        tx,
        attendingHostUserIds,
        inserted.id,
        slotStartUtc,
        slotEndUtc,
        eventType.bufferBefore,
        eventType.bufferAfter
      );

      await tx.insert(attendees).values({
        bookingId: inserted.id,
        email: input.attendee.email,
        name: input.attendee.name ?? null,
        timezone: input.attendee.timezone ?? null,
        phone: input.attendee.phone ?? null,
      });

      return {
        uid,
        eventTypeId: input.eventTypeId,
        hostUserId,
        attendingHostUserIds,
        startUtc: slotStartUtc,
        endUtc: slotEndUtc,
        status: "accepted",
        location: chosen,
        attendee: {
          email: input.attendee.email,
          name: input.attendee.name ?? null,
          phone: input.attendee.phone ?? null,
        },
      };
    });
}
