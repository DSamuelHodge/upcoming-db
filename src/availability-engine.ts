import { DateTime, Interval } from "luxon";

// ============================================================================
// Domain types — repository-agnostic. The engine never sees Drizzle, Prisma,
// or raw SQL; it only depends on this interface, so it's testable with an
// in-memory fake and swappable across data layers without touching the math.
// ============================================================================

export interface AvailabilityRule {
  dayOfWeek: number | null; // 0 (Sun) - 6 (Sat); null if this is a date override
  dateOverride: string | null; // ISO date 'YYYY-MM-DD'; null if recurring
  startTime: string; // 'HH:mm' in the schedule's timezone (wall clock, not UTC)
  endTime: string; // 'HH:mm' in the schedule's timezone
}

export interface Schedule {
  timezone: string; // IANA tz name, e.g. 'America/New_York'
  availability: AvailabilityRule[];
}

export interface EventType {
  lengthMinutes: number;
  bufferBefore: number; // minutes, blocks adjacent bookings but isn't offered as a slot
  bufferAfter: number;
  minBookingNoticeMinutes: number;
  slotIntervalMinutes?: number; // step between slot starts; defaults to lengthMinutes
}

export interface ExistingBooking {
  startTimeUtc: string; // ISO 8601 UTC instant
  endTimeUtc: string;
  /** Snapshotted onto the booking row at insert time; not the live event-type values. */
  bufferBefore: number;
  bufferAfter: number;
}

export interface TimeSlot {
  startUtc: string; // ISO instant
  endUtc: string;
}

/** Instant identity that does not depend on Z vs +00:00 or millisecond formatting. */
export function utcSlotKey(startUtc: string, endUtc: string): string {
  const start = DateTime.fromISO(startUtc, { zone: "utc" });
  const end = DateTime.fromISO(endUtc, { zone: "utc" });
  return `${start.toMillis()}|${end.toMillis()}`;
}

export interface AvailabilityRepository {
  getSchedule(userId: number): Promise<Schedule>;
  getEventType(eventTypeId: number): Promise<EventType>;
  getBookingsInRange(userId: number, startUtc: string, endUtc: string): Promise<ExistingBooking[]>;
}

export interface ComputeAvailabilityParams {
  userId: number;
  eventTypeId: number;
  rangeStartUtc: string; // ISO instant, inclusive
  rangeEndUtc: string; // ISO instant, exclusive
  now?: DateTime; // injectable for deterministic tests
}

/** Fetch bookings this far past the requested range so another booking's stored buffer can reach in. */
const BOOKING_FETCH_PAD_MINUTES = 1440;

// ============================================================================
// Entry point
// ============================================================================

export async function computeAvailability(
  repo: AvailabilityRepository,
  params: ComputeAvailabilityParams
): Promise<TimeSlot[]> {
  const { userId, eventTypeId, rangeStartUtc, rangeEndUtc } = params;
  const now = params.now ?? DateTime.utc();

  const fetchStartUtc = DateTime.fromISO(rangeStartUtc, { zone: "utc" })
    .minus({ minutes: BOOKING_FETCH_PAD_MINUTES })
    .toISO()!;
  const fetchEndUtc = DateTime.fromISO(rangeEndUtc, { zone: "utc" })
    .plus({ minutes: BOOKING_FETCH_PAD_MINUTES })
    .toISO()!;

  const [schedule, eventType, existingBookings] = await Promise.all([
    repo.getSchedule(userId),
    repo.getEventType(eventTypeId),
    repo.getBookingsInRange(userId, fetchStartUtc, fetchEndUtc),
  ]);

  const tz = schedule.timezone;
  const rangeStartLocal = DateTime.fromISO(rangeStartUtc, { zone: "utc" }).setZone(tz);
  const rangeEndLocal = DateTime.fromISO(rangeEndUtc, { zone: "utc" }).setZone(tz);

  // Widen existing bookings by the buffers stored on the row. Luxon
  // Interval.overlaps is false for abutting ends; a nonzero buffer turns
  // abutment into overlap. Zero buffers allow back-to-back bookings.
  const bookedIntervals = existingBookings.flatMap((b) => {
    const start = DateTime.fromISO(b.startTimeUtc, { zone: "utc" }).minus({
      minutes: Math.max(0, b.bufferBefore),
    });
    const end = DateTime.fromISO(b.endTimeUtc, { zone: "utc" }).plus({
      minutes: Math.max(0, b.bufferAfter),
    });
    const interval = Interval.fromDateTimes(start, end);
    return interval.isValid ? [interval] : [];
  });

  const earliestBookable = now.plus({ minutes: eventType.minBookingNoticeMinutes });

  const slots: TimeSlot[] = [];

  // Walk day by day in the SCHEDULE's local calendar. This is the key DST-safety
  // decision: we never compute in UTC and reinterpret locally. Each day's window
  // is built from local wall-clock time, and Luxon resolves the correct UTC offset
  // for that specific date — so the offset can legitimately differ between the
  // first and last day of the range if it spans a DST transition, and the math
  // stays correct without any special-casing on our part.
  let cursor = rangeStartLocal.startOf("day");
  while (cursor < rangeEndLocal) {
    const isoDate = cursor.toISODate()!;
    const windows = resolveWorkingWindowsForDate(schedule, isoDate, tz);

    for (const window of windows) {
      slots.push(...generateSlotsInWindow(window, eventType, bookedIntervals, earliestBookable));
    }

    cursor = cursor.plus({ days: 1 });
  }

  // Final clip to the requested range, since day-boundary walking can generate
  // slots that spill slightly outside it (e.g. a window starting before midnight
  // local time on the range's start date, if that date's own offset differs).
  const rangeStartInstant = DateTime.fromISO(rangeStartUtc, { zone: "utc" });
  const rangeEndInstant = DateTime.fromISO(rangeEndUtc, { zone: "utc" });
  const clipped = slots.filter((s) => {
    const start = DateTime.fromISO(s.startUtc, { zone: "utc" });
    return start >= rangeStartInstant && start < rangeEndInstant;
  });
  const seen = new Set<string>();
  return clipped.filter((s) => {
    const key = utcSlotKey(s.startUtc, s.endUtc);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// Working window resolution
// ============================================================================

function weekdaySun0(isoDate: string, tz: string): number {
  return DateTime.fromISO(isoDate, { zone: tz }).weekday % 7; // Luxon 1=Mon..7=Sun -> 0=Sun..6=Sat
}

function previousIsoDate(isoDate: string, tz: string): string {
  return DateTime.fromISO(isoDate, { zone: tz }).minus({ days: 1 }).toISODate()!;
}

function nextIsoDate(isoDate: string, tz: string): string {
  return DateTime.fromISO(isoDate, { zone: tz }).plus({ days: 1 }).toISODate()!;
}

/** Date overrides replace weekday rules for that local date. */
function rulesForDate(schedule: Schedule, isoDate: string, tz: string): AvailabilityRule[] {
  const overridesForDate = schedule.availability.filter((r) => r.dateOverride === isoDate);
  if (overridesForDate.length > 0) return overridesForDate;
  const weekday = weekdaySun0(isoDate, tz);
  return schedule.availability.filter((r) => r.dateOverride === null && r.dayOfWeek === weekday);
}

function resolveWorkingWindowsForDate(schedule: Schedule, isoDate: string, tz: string): Interval[] {
  const today = rulesForDate(schedule, isoDate, tz).flatMap((rule) =>
    windowsForRuleOnDate(rule, isoDate, tz, isoDate)
  );
  const yesterday = previousIsoDate(isoDate, tz);
  const spill = rulesForDate(schedule, yesterday, tz).flatMap((rule) =>
    windowsForRuleOnDate(rule, yesterday, tz, isoDate)
  );
  return mergeIntervals([...today, ...spill]);
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.isValid && interval.start && interval.end)
    .sort((a, b) => a.start!.toMillis() - b.start!.toMillis());
  const merged: Interval[] = [];
  for (const next of sorted) {
    const last = merged[merged.length - 1];
    if (!last || last.end! < next.start!) {
      merged.push(next);
      continue;
    }
    const end = last.end! >= next.end! ? last.end! : next.end!;
    const union = Interval.fromDateTimes(last.start!, end);
    if (union.isValid) merged[merged.length - 1] = union;
  }
  return merged;
}

function parseHm(hhmm: string): { hour: number; minute: number } | null {
  const [hour, minute] = hhmm.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute };
}

function formatHm(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Exact local wall-clock on a calendar date. Null if that clock time does not exist (DST gap). Fall-back ambiguity uses the first occurrence. */
function exactWallClock(isoDate: string, hhmm: string, tz: string): DateTime | null {
  const hm = parseHm(hhmm);
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!hm) return null;
  const dt = DateTime.fromObject({ year, month, day, hour: hm.hour, minute: hm.minute }, { zone: tz });
  if (!dt.isValid) return null;
  if (dt.hour !== hm.hour || dt.minute !== hm.minute) return null;
  return dt;
}

function firstValidAtOrAfter(isoDate: string, hhmm: string, tz: string): DateTime | null {
  const hm = parseHm(hhmm);
  if (!hm) return null;
  const exact = exactWallClock(isoDate, hhmm, tz);
  if (exact) return exact;
  for (let m = hm.hour * 60 + hm.minute + 1; m < 24 * 60; m++) {
    const candidate = exactWallClock(isoDate, formatHm(m), tz);
    if (candidate) return candidate;
  }
  return null;
}

function lastValidAtOrBefore(isoDate: string, hhmm: string, tz: string): DateTime | null {
  const hm = parseHm(hhmm);
  if (!hm) return null;
  const exact = exactWallClock(isoDate, hhmm, tz);
  if (exact) return exact;
  for (let m = hm.hour * 60 + hm.minute - 1; m >= 0; m--) {
    const candidate = exactWallClock(isoDate, formatHm(m), tz);
    if (candidate) return candidate;
  }
  return null;
}

function asInterval(start: DateTime, end: DateTime): Interval[] {
  const interval = Interval.fromDateTimes(start, end);
  return interval.isValid ? [interval] : [];
}

function overnightWindows(
  start: DateTime,
  endTime: string,
  ruleDate: string,
  tz: string,
  targetDate: string
): Interval[] {
  const nextDate = nextIsoDate(ruleDate, tz);
  if (targetDate === ruleDate) {
    return asInterval(start, start.startOf("day").plus({ days: 1 }));
  }
  if (targetDate === nextDate) {
    // Next-day end must exist as a real local instant; a DST gap must not wrap.
    const endNext = exactWallClock(nextDate, endTime, tz);
    if (!endNext) return [];
    return asInterval(endNext.startOf("day"), endNext);
  }
  return [];
}

function windowsForRuleOnDate(
  rule: AvailabilityRule,
  ruleDate: string,
  tz: string,
  targetDate: string
): Interval[] {
  const exactStart = exactWallClock(ruleDate, rule.startTime, tz);
  const exactEnd = exactWallClock(ruleDate, rule.endTime, tz);

  if (exactStart && exactEnd && exactEnd > exactStart) {
    if (ruleDate !== targetDate) return [];
    return asInterval(exactStart, exactEnd);
  }

  // Both wall-clocks exist on this local calendar day and end is not after start
  // in UTC — that is a true overnight, not a DST-gapped same-day window.
  if (exactStart && exactEnd) {
    return overnightWindows(exactStart, rule.endTime, ruleDate, tz, targetDate);
  }

  if (ruleDate !== targetDate) return [];

  const start = exactStart ?? firstValidAtOrAfter(ruleDate, rule.startTime, tz);
  const end = exactEnd ?? lastValidAtOrBefore(ruleDate, rule.endTime, tz);
  if (!start || !end || end <= start) return [];
  return asInterval(start, end);
}

// ============================================================================
// Slot generation
// ============================================================================

/**
 * Slices a working window into bookable slots, applying event length, buffers,
 * conflict filtering against existing bookings, and the minimum booking notice.
 */
function generateSlotsInWindow(
  window: Interval,
  eventType: EventType,
  bookedIntervals: Interval[],
  earliestBookable: DateTime
): TimeSlot[] {
  const step = eventType.slotIntervalMinutes ?? eventType.lengthMinutes;
  if (eventType.lengthMinutes <= 0 || step <= 0) return [];

  const slots: TimeSlot[] = [];

  let slotStart = window.start!;
  while (true) {
    const slotEnd = slotStart.plus({ minutes: eventType.lengthMinutes });
    if (slotEnd > window.end!) break;

    const occupied = Interval.fromDateTimes(
      slotStart.minus({ minutes: Math.max(0, eventType.bufferBefore) }),
      slotEnd.plus({ minutes: Math.max(0, eventType.bufferAfter) })
    );

    if (!occupied.isValid) {
      slotStart = slotStart.plus({ minutes: step });
      continue;
    }

    const tooSoon = slotStart < earliestBookable;
    const conflicts = bookedIntervals.some((b) => b.overlaps(occupied));

    if (!tooSoon && !conflicts) {
      slots.push({ startUtc: slotStart.toUTC().toISO()!, endUtc: slotEnd.toUTC().toISO()! });
    }

    slotStart = slotStart.plus({ minutes: step });
  }

  return slots;
}
