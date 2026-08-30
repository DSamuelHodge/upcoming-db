import { eq, asc } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { EventType as EngineEventType } from "./availability-engine";

export class EventTypeNotFoundError extends Error {}

/** Drizzle db or transaction — both expose the relational `query` API. */
export type SchemaClient = {
  query: LibSQLDatabase<typeof schema>["query"];
};

export interface LoadedEventType extends EngineEventType {
  id: number;
  schedulingType: "individual" | "round_robin" | "collective";
  hostUserIds: number[]; // ordered by priority ascending (index 0 = preferred / organizer of record)
}

/**
 * Loads an event type and its hosts uniformly regardless of scheduling type.
 * Individual event types are expected to have exactly one row in
 * event_type_hosts — this keeps callers (get_availability, create_booking)
 * free of any "if individual, read owner_user_id instead" branching.
 */
export async function loadEventType(
  db: SchemaClient,
  eventTypeId: number
): Promise<LoadedEventType> {
  const row = await db.query.eventTypes.findFirst({
    where: eq(schema.eventTypes.id, eventTypeId),
  });
  if (!row) throw new EventTypeNotFoundError(`event_type ${eventTypeId} not found`);

  const hostLinks = await db.query.eventTypeHosts.findMany({
    where: eq(schema.eventTypeHosts.eventTypeId, eventTypeId),
    orderBy: [asc(schema.eventTypeHosts.priority), asc(schema.eventTypeHosts.hostUserId)],
  });
  if (hostLinks.length === 0) {
    throw new EventTypeNotFoundError(
      `event_type ${eventTypeId} has no hosts configured in event_type_hosts`
    );
  }

  return {
    id: row.id,
    lengthMinutes: row.lengthMinutes,
    bufferBefore: row.bufferBefore,
    bufferAfter: row.bufferAfter,
    minBookingNoticeMinutes: row.minBookingNotice,
    slotIntervalMinutes: row.slotIntervalMinutes ?? undefined,
    schedulingType: row.schedulingType,
    hostUserIds: hostLinks.map((h) => h.hostUserId),
  };
}
