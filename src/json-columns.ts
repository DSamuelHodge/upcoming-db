import { z } from "zod";
import type { ChosenLocation } from "./notifications";

/**
 * Strict parsers for the JSON-in-TEXT columns. Malformed or wrongly-shaped
 * data throws (fails loudly) instead of silently degrading — a silent `[]`
 * menu would, for example, reject every location choice with a misleading
 * "not offered" error.
 */

export class InvalidJsonColumnError extends Error {
  constructor(
    readonly column: string,
    cause: unknown
  ) {
    super(`Invalid JSON in column ${column}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "InvalidJsonColumnError";
  }
}

export const ChosenLocationSchema = z
  .object({
    type: z.enum(["integrations:daily", "inPerson", "userPhone"]),
    label: z.string().optional(),
    address: z.string().optional(),
    phone: z.string().optional(),
    displayPhone: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough(); // event_types.locations allows passthrough fields

export const EventLocationsSchema = z.array(ChosenLocationSchema);

export const UserMetadataSchema = z.record(z.unknown());

function parseJsonColumn(column: string, raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidJsonColumnError(column, "empty or non-string value");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new InvalidJsonColumnError(column, err);
  }
}

export function parseLocationsColumn(raw: unknown): ChosenLocation[] {
  const parsed = parseJsonColumn("event_types.locations", raw);
  const result = EventLocationsSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidJsonColumnError("event_types.locations", result.error);
  }
  return result.data;
}

/** No runtime consumer reads users.metadata yet; use this at the first read site. */
export function parseUserMetadata(raw: unknown): Record<string, unknown> {
  const parsed = parseJsonColumn("users.metadata", raw);
  const result = UserMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidJsonColumnError("users.metadata", result.error);
  }
  return result.data;
}
