import assert from "node:assert/strict";
import { test } from "node:test";
import { DateTime } from "luxon";
import { AvailabilityRepository, utcSlotKey } from "./availability-engine";
import { assignRoundRobinHost, computeMultiHostAvailability, HostLoadRepository } from "./multi-host-routing";

test("utcSlotKey treats Z and +00:00 as the same slot", () => {
  assert.equal(
    utcSlotKey("2026-03-09T13:00:00.000Z", "2026-03-09T13:30:00.000Z"),
    utcSlotKey("2026-03-09T13:00:00+00:00", "2026-03-09T13:30:00+00:00")
  );
});

test("collective intersection requires every host to offer the same instant", async () => {
  const repo: AvailabilityRepository = {
    getSchedule: async () => ({
      timezone: "UTC",
      availability: [{ dayOfWeek: null, dateOverride: "2026-03-09", startTime: "13:00", endTime: "14:00" }],
    }),
    getEventType: async () => ({
      lengthMinutes: 30,
      bufferBefore: 0,
      bufferAfter: 0,
      minBookingNoticeMinutes: 0,
    }),
    getBookingsInRange: async () => [],
  };

  const offered = await computeMultiHostAvailability(repo, {
    eventTypeId: 1,
    hostUserIds: [1, 2],
    schedulingType: "collective",
    rangeStartUtc: "2026-03-09T13:00:00.000Z",
    rangeEndUtc: "2026-03-09T14:00:00.000Z",
    now: DateTime.fromISO("2026-03-01T00:00:00.000Z", { zone: "utc" }),
  });

  assert.equal(offered.length, 2);
  assert.deepEqual(
    offered.map((s) => s.attendingHostUserIds),
    [
      [1, 2],
      [1, 2],
    ]
  );
});

test("round-robin picks never-assigned host, then least-recent by instant not ISO spelling", async () => {
  const lastAssigned = new Map<number, string | null>([
    [1, "2026-01-01T00:00:00.000Z"],
    [2, "2026-01-01T00:00:00+00:00"],
    [3, null],
  ]);

  const repo: AvailabilityRepository & HostLoadRepository = {
    getSchedule: async () => ({ timezone: "UTC", availability: [] }),
    getEventType: async () => ({
      lengthMinutes: 30,
      bufferBefore: 0,
      bufferAfter: 0,
      minBookingNoticeMinutes: 0,
    }),
    getBookingsInRange: async () => [],
    getLastAssignedAt: async () => lastAssigned,
  };

  const neverAssigned = await assignRoundRobinHost(repo, {
    eventTypeId: 1,
    candidateHostUserIds: [1, 2, 3],
    slotStartUtc: "2026-03-09T13:00:00.000Z",
    slotEndUtc: "2026-03-09T13:30:00.000Z",
  });
  assert.equal(neverAssigned, 3);

  const tiedInstants = await assignRoundRobinHost(repo, {
    eventTypeId: 1,
    candidateHostUserIds: [2, 1],
    slotStartUtc: "2026-03-09T13:00:00.000Z",
    slotEndUtc: "2026-03-09T13:30:00.000Z",
  });
  assert.equal(tiedInstants, 2);
});
