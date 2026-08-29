// First consumer contract for `users.metadata` (see the strict-parse note in
// schema.ts). Everything in user settings that is not a dedicated column lives
// here. Malformed metadata fails loudly — it is never silently treated as {}.
import { z } from "zod";

// A Locations-menu entry (api-contract.md §Locations menu): `type` is
// constrained, everything else passes through (label, address, phone, url...).
export const LocationEntry = z
  .object({ type: z.enum(["integrations:daily", "inPerson", "userPhone"]) })
  .passthrough();

export const UserMetadata = z
  .object({
    // User-level default location; clients prefill new event types' location
    // menus with it.
    defaultLocation: LocationEntry.optional(),
    prefs: z
      .object({ timeFormat: z.enum(["12h", "24h"]) })
      .strict()
      .optional(),
    // Profile context (populated by seed data, rendered by clients).
    role: z.string().max(120).optional(),
    company: z.string().max(120).optional(),
  })
  .strict();

export type UserMetadataValue = z.infer<typeof UserMetadata>;
export type LocationEntryValue = z.infer<typeof LocationEntry>;

// Returns the parsed metadata value or throws (ZodError) — loud on purpose.
export function parseUserMetadata(raw: string): UserMetadataValue {
  return UserMetadata.parse(JSON.parse(raw));
}

// Serializes a validated metadata value back to the JSON column.
export function stringifyUserMetadata(value: UserMetadataValue): string {
  return JSON.stringify(UserMetadata.parse(value));
}
