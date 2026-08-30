import assert from "node:assert/strict";
import { test } from "node:test";
import { DateTime } from "luxon";
import {
  AvailabilityRepository,
  computeAvailability,
  EventType,
  ExistingBooking,
  Schedule,
} from "./availability-engine";

const TZ = "America/New_York";

const thirtyMin: EventType = {
  lengthMinutes: 30,
  bufferBefore: 0,
  bufferAfter: 0,
  minBookingNoticeMinutes: 0,
  slotIntervalMinutes: 30,
};

function repo(opts: {
  schedule: Schedule;
  eventType?: EventType;
  bookings?: ExistingBooking[];
}): AvailabilityRepository {
  return {
    getSchedule: async () => opts.schedule,
    getEventType: async () => opts.eventType ?? thirtyMin,
    getBookingsInRange: async () => opts.bookings ?? [],
  };
}

function overrideSchedule(isoDate: string, startTime: string, endTime: string): Schedule {
  return {
    timezone: TZ,
    availability: [{ dayOfWeek: null, dateOverride: isoDate, startTime, endTime }],
  };
}

test("spring-forward 2026-03-08: 01:00–04:00 local yields 4 half-hour slots, not a naive 6", async () => {
  // Clocks jump 02:00 -> 03:00. Duration math skips the gap; wall-clock counting does not.
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-08", "01:00", "04:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-08T00:00:00.000Z",
      rangeEndUtc: "2026-03-09T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  assert.equal(slots.length, 4);
  assert.deepEqual(
    slots.map((s) => s.startUtc),
    [
      "2026-03-08T06:00:00.000Z", // 01:00 EST (UTC-5)
      "2026-03-08T06:30:00.000Z", // 01:30 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT (UTC-4)
      "2026-03-08T07:30:00.000Z", // 03:30 EDT
    ]
  );
});

test("spring-forward 2026-03-08: 09:00–17:00 offsets follow the tz database, not a fixed UTC-5", async () => {
  const slots = await computeAvailability(
    repo({
      schedule: overrideSchedule("2026-03-08", "09:00", "17:00"),
      eventType: { ...thirtyMin, lengthMinutes: 60, slotIntervalMinutes: 60 },
    }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-08T00:00:00.000Z",
      rangeEndUtc: "2026-03-09T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  assert.equal(slots.length, 8);
  // Transition is 02:00, so 09:00 is already EDT (UTC-4), not EST (UTC-5).
  assert.equal(slots[0]!.startUtc, "2026-03-08T13:00:00.000Z"); // 09:00 EDT
  assert.equal(slots[4]!.startUtc, "2026-03-08T17:00:00.000Z"); // 13:00 EDT, not 18:00Z (naive UTC-5)
});

test("fall-back 2026-11-01: 00:00–03:00 local yields 8 half-hour slots (4 elapsed hours), not a naive 6", async () => {
  // 02:00 EDT -> 01:00 EST. Window is 3 wall-clock hours and 4 elapsed hours.
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-11-01", "00:00", "03:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-11-01T00:00:00.000Z",
      rangeEndUtc: "2026-11-02T00:00:00.000Z",
      now: DateTime.fromISO("2026-10-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  assert.equal(slots.length, 8);
  assert.deepEqual(
    slots.map((s) => s.startUtc),
    [
      "2026-11-01T04:00:00.000Z", // 00:00 EDT
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:00:00.000Z", // 01:00 EDT (first)
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z", // 01:00 EST (second)
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z", // 02:00 EST
      "2026-11-01T07:30:00.000Z",
    ]
  );
});

test("existing booking bufferAfter blocks an abutting candidate even when the candidate's bufferBefore is 0", async () => {
  // 2026-03-09 is EDT. 09:00 local = 13:00Z.
  const slots = await computeAvailability(
    repo({
      schedule: overrideSchedule("2026-03-09", "09:00", "11:00"),
      bookings: [
        {
          startTimeUtc: "2026-03-09T13:00:00.000Z",
          endTimeUtc: "2026-03-09T13:30:00.000Z",
          bufferBefore: 0,
          bufferAfter: 15,
        },
      ],
    }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-10T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts.includes("2026-03-09T13:00:00.000Z"), false);
  assert.equal(starts.includes("2026-03-09T13:30:00.000Z"), false); // 09:30 abuts buffered 09:00–09:45
  assert.equal(starts.includes("2026-03-09T14:00:00.000Z"), true); // 10:00 is past the 15-minute after-buffer
});

test("zero buffers on both sides still allow back-to-back slots (policy, not a bug)", async () => {
  const slots = await computeAvailability(
    repo({
      schedule: overrideSchedule("2026-03-09", "09:00", "11:00"),
      bookings: [
        {
          startTimeUtc: "2026-03-09T13:00:00.000Z",
          endTimeUtc: "2026-03-09T13:30:00.000Z",
          bufferBefore: 0,
          bufferAfter: 0,
        },
      ],
    }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-10T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts.includes("2026-03-09T13:30:00.000Z"), true);
});

test("spring-forward 01:00–02:30 is not overnight and does not wrap into the next morning", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-08", "01:00", "02:30") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-08T00:00:00.000Z",
      rangeEndUtc: "2026-03-10T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts.includes("2026-03-08T06:00:00.000Z"), true); // 01:00 EST
  assert.equal(
    starts.some((s) => DateTime.fromISO(s, { zone: "utc" }) >= DateTime.fromISO("2026-03-08T07:00:00.000Z")),
    false
  );
});

test("overnight 22:00–02:30 still offers the evening when the next-day end is gapped", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-07", "22:00", "02:30") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-07T00:00:00.000Z",
      rangeEndUtc: "2026-03-09T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts.includes("2026-03-08T03:00:00.000Z"), true); // 22:00 EST Mar 7
  assert.equal(starts.includes("2026-03-08T06:00:00.000Z"), false); // 01:00 EDT Mar 8 would be a spill if 02:30 existed
});

test("spring-forward 02:30–12:00 starts at 03:00, not an empty morning", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-08", "02:30", "12:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-08T00:00:00.000Z",
      rangeEndUtc: "2026-03-09T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts[0], "2026-03-08T07:00:00.000Z"); // 03:00 EDT
  assert.equal(starts.includes("2026-03-08T15:30:00.000Z"), true); // 11:30 EDT last 30-min start before 12:00
  assert.equal(
    starts.some((s) => DateTime.fromISO(s, { zone: "utc" }) < DateTime.fromISO("2026-03-08T07:00:00.000Z")),
    false
  );
});

test("fall-back 01:00–02:30 is same-day and walks the overlap hour once", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-11-01", "01:00", "02:30") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-11-01T00:00:00.000Z",
      rangeEndUtc: "2026-11-02T00:00:00.000Z",
      now: DateTime.fromISO("2026-10-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  assert.deepEqual(
    slots.map((s) => s.startUtc),
    [
      "2026-11-01T05:00:00.000Z", // 01:00 EDT (first)
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z", // 01:00 EST (second)
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z", // 02:00 EST
    ]
  );
});

test("real overnight 22:00–02:00 spans midnight", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-09", "22:00", "02:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-11T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts[0], "2026-03-10T02:00:00.000Z"); // 22:00 EDT Mar 9
  assert.equal(starts.includes("2026-03-10T04:00:00.000Z"), true); // 00:00 EDT Mar 10
  assert.equal(starts[starts.length - 1], "2026-03-10T05:30:00.000Z"); // 01:30 EDT
  assert.equal(slots.length, 8);
});

test("overnight 22:00–06:00 spills into the next local morning", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-09", "22:00", "06:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-11T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  const starts = slots.map((s) => s.startUtc);
  assert.equal(starts[0], "2026-03-10T02:00:00.000Z"); // 22:00 EDT Mar 9
  assert.equal(starts.includes("2026-03-10T04:00:00.000Z"), true); // 00:00 EDT Mar 10
  assert.equal(starts[starts.length - 1], "2026-03-10T09:30:00.000Z"); // 05:30 EDT Mar 10
  assert.equal(slots.length, 16);
});

test("overnight spill plus next-day morning window does not duplicate slots", async () => {
  const slots = await computeAvailability(
    repo({
      schedule: {
        timezone: TZ,
        availability: [
          { dayOfWeek: null, dateOverride: "2026-03-09", startTime: "22:00", endTime: "06:00" },
          { dayOfWeek: null, dateOverride: "2026-03-10", startTime: "00:00", endTime: "06:00" },
        ],
      },
    }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-11T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  const keys = slots.map((s) => `${s.startUtc}|${s.endUtc}`);
  assert.equal(keys.length, new Set(keys).size);
  const morning = slots.filter((s) => s.startUtc >= "2026-03-10T04:00:00.000Z" && s.startUtc < "2026-03-10T10:00:00.000Z");
  assert.equal(morning.length, 12); // 00:00–06:00 EDT, 30-min starts
});

test("non-positive length produces no slots", async () => {
  const slots = await computeAvailability(
    repo({
      schedule: overrideSchedule("2026-03-09", "09:00", "11:00"),
      eventType: { ...thirtyMin, lengthMinutes: 0 },
    }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T00:00:00.000Z",
      rangeEndUtc: "2026-03-10T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );
  assert.equal(slots.length, 0);
});

test("slot matching treats Z and +00:00 as the same instant", async () => {
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-09", "09:00", "10:00") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-09T13:00:00+00:00",
      rangeEndUtc: "2026-03-09T14:00:00+00:00",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  assert.equal(slots.length, 2);
  const target = DateTime.fromISO("2026-03-09T13:00:00Z", { zone: "utc" });
  assert.equal(
    slots.some((s) => DateTime.fromISO(s.startUtc, { zone: "utc" }).equals(target)),
    true
  );
});

test("spring-forward 2026-03-08: 02:15–02:45 local (both ends nonexistent) yields zero slots", async () => {
  // Both the window start and end fall inside the 02:00->03:00 gap.
  // firstValidAtOrAfter / lastValidAtOrBefore snap both ends to 03:00 EDT,
  // producing end <= start — the engine must resolve that to zero slots,
  // not loop or emit a degenerate slot.
  const slots = await computeAvailability(
    repo({ schedule: overrideSchedule("2026-03-08", "02:15", "02:45") }),
    {
      userId: 1,
      eventTypeId: 1,
      rangeStartUtc: "2026-03-08T00:00:00.000Z",
      rangeEndUtc: "2026-03-09T00:00:00.000Z",
      now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
    }
  );

  assert.equal(slots.length, 0);
});
