import { DateTime } from "luxon";
import {
  computeAvailability,
  AvailabilityRepository,
  TimeSlot,
  ComputeAvailabilityParams,
  utcSlotKey,
} from "./availability-engine";

// ============================================================================
// This module never touches DST/slot-generation math — it composes
// `computeAvailability` per host and layers routing rules on top. That
// separation is the point: single-host math stays deterministic and pure;
// multi-host policy (which can change per business requirement) lives here.
// ============================================================================

export type SchedulingType = "collective" | "round_robin";

export interface HostLoadRepository {
  /** Timestamp of each host's most recently *assigned* round-robin booking,
   *  used for least-recently-booked fairness. Hosts with no prior bookings
   *  should sort first (treat as epoch/null). */
  getLastAssignedAt(hostUserIds: number[], eventTypeId: number): Promise<Map<number, string | null>>;
}

export interface MultiHostAvailabilityParams {
  eventTypeId: number;
  hostUserIds: number[];
  schedulingType: SchedulingType;
  rangeStartUtc: string;
  rangeEndUtc: string;
  now?: DateTime;
}

/** A slot offered to the agent. For collective, all hosts attend — no
 *  assignment ambiguity. For round-robin, this is a query-time PREVIEW only;
 *  the real host is picked later, atomically, in the booking transaction. */
export interface OfferedSlot extends TimeSlot {
  schedulingType: SchedulingType;
  attendingHostUserIds?: number[]; // collective only
}

// ============================================================================
// Query-time: what slots can be offered
// ============================================================================

export async function computeMultiHostAvailability(
  repo: AvailabilityRepository,
  params: MultiHostAvailabilityParams
): Promise<OfferedSlot[]> {
  const perHost = await Promise.all(
    params.hostUserIds.map(async (userId) => ({
      userId,
      slots: await computeAvailability(repo, {
        userId,
        eventTypeId: params.eventTypeId,
        rangeStartUtc: params.rangeStartUtc,
        rangeEndUtc: params.rangeEndUtc,
        now: params.now,
      } satisfies ComputeAvailabilityParams),
    }))
  );

  return params.schedulingType === "collective"
    ? intersectSlots(perHost, params.schedulingType)
    : unionSlots(perHost, params.schedulingType);
}

/** Collective: a slot only counts if every host's engine independently
 *  produced it. Matched on exact start/end instant — hosts must share
 *  identical slot boundaries for a given event type, which holds as long
 *  as they share the same eventType.lengthMinutes/slotIntervalMinutes. */
function intersectSlots(
  perHost: { userId: number; slots: TimeSlot[] }[],
  schedulingType: SchedulingType
): OfferedSlot[] {
  if (perHost.length === 0) return [];

  const [first, ...rest] = perHost;
  const result: OfferedSlot[] = [];

  for (const slot of first.slots) {
    const key = utcSlotKey(slot.startUtc, slot.endUtc);
    const presentEverywhere = rest.every((h) =>
      h.slots.some((s) => utcSlotKey(s.startUtc, s.endUtc) === key)
    );
    if (presentEverywhere) {
      result.push({
        ...slot,
        schedulingType,
        attendingHostUserIds: perHost.map((h) => h.userId),
      });
    }
  }
  return result;
}

/** Round-robin: a slot is offered if ANY host is free then. Deduplicated by
 *  start/end instant. No host is attached here — see assignRoundRobinHost. */
function unionSlots(
  perHost: { userId: number; slots: TimeSlot[] }[],
  schedulingType: SchedulingType
): OfferedSlot[] {
  const byInstant = new Map<string, OfferedSlot>();
  for (const host of perHost) {
    for (const slot of host.slots) {
      const key = utcSlotKey(slot.startUtc, slot.endUtc);
      if (!byInstant.has(key)) {
        byInstant.set(key, { ...slot, schedulingType });
      }
    }
  }
  return [...byInstant.values()].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

// ============================================================================
// Booking-time: atomic round-robin host assignment
//
// Call this INSIDE the same transaction as the booking insert, after
// re-verifying the chosen host's availability for the exact slot — never
// reuse a host decision computed during the earlier query-time preview,
// since time has passed and another agent call may have booked that host.
// ============================================================================

export async function assignRoundRobinHost(
  repo: AvailabilityRepository & HostLoadRepository,
  params: {
    eventTypeId: number;
    candidateHostUserIds: number[]; // hosts free for THIS exact slot, re-checked now
    slotStartUtc: string;
    slotEndUtc: string;
  }
): Promise<number> {
  if (params.candidateHostUserIds.length === 0) {
    throw new Error("No candidate hosts available for round-robin assignment");
  }

  const lastAssigned = await repo.getLastAssignedAt(params.candidateHostUserIds, params.eventTypeId);
  const priorityOrder = new Map(params.candidateHostUserIds.map((id, index) => [id, index]));

  const lastAssignedMs = (hostUserId: number): number => {
    const raw = lastAssigned.get(hostUserId);
    if (!raw) return 0;
    const ms = DateTime.fromISO(raw, { zone: "utc" }).toMillis();
    return Number.isFinite(ms) ? ms : 0;
  };

  // Least-recently-booked by instant, then the caller’s priority order (event_type_hosts).
  const [chosen] = [...params.candidateHostUserIds].sort((a, b) => {
    const byTime = lastAssignedMs(a) - lastAssignedMs(b);
    if (byTime !== 0) return byTime;
    return (priorityOrder.get(a) ?? 0) - (priorityOrder.get(b) ?? 0);
  });

  return chosen;
}

// ============================================================================
// Usage from MCP tool handlers
// ============================================================================
//
// get_availability tool (round_robin/collective event types):
//   const offered = await computeMultiHostAvailability(repo, {
//     eventTypeId, hostUserIds, schedulingType, rangeStartUtc, rangeEndUtc,
//   });
//
// create_booking tool, inside a DB transaction, only for round_robin:
//   const stillFreeHosts = await filterStillAvailable(repo, candidateHostUserIds, slot); // re-run computeAvailability per host for this instant
//   const hostUserId = await assignRoundRobinHost(repo, { eventTypeId, candidateHostUserIds: stillFreeHosts, slotStartUtc, slotEndUtc });
//   // then INSERT the booking with host_user_id = hostUserId, still inside the
//   // same transaction/idempotency-key guard discussed earlier, so a concurrent
//   // call racing for the same host+slot fails the uniqueness check instead of
//   // double-booking them.
