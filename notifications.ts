import { DateTime } from "luxon";
import type { BookingResult } from "./create-booking-handler";

export type ChosenLocation = {
  type: "integrations:daily" | "inPerson" | "userPhone";
  label?: string;
  address?: string;
  phone?: string;
  displayPhone?: string;
  url?: string;
  // allow passthrough fields from event_types.locations
  [key: string]: unknown;
};

// Business/PII-ish config lives in env (BUSINESS_ADDRESS / BUSINESS_MAPS_URL /
// BUSINESS_PHONE). When unset, blocks render neutral "contact us" fallbacks
// instead of any specific address or number.
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS ?? "";
const BUSINESS_MAPS_URL = process.env.BUSINESS_MAPS_URL ?? "";
const BUSINESS_PHONE = process.env.BUSINESS_PHONE ?? "";

export function locationBlockText(loc: ChosenLocation, guestPhone?: string | null): string {
  switch (loc.type) {
    case "integrations:daily":
      return loc.url ? `Video (Daily.co): ${loc.url}` : "Video (Daily.co): link to follow";
    case "inPerson": {
      const addr = (loc.address as string) ?? BUSINESS_ADDRESS;
      const parts = ["In person — Brick House Blue, Hilliard"];
      if (addr) parts.push(addr);
      if (BUSINESS_MAPS_URL) parts.push(`Map: ${BUSINESS_MAPS_URL}`);
      if (!addr && !BUSINESS_MAPS_URL) parts.push("Contact us for location details.");
      return parts.join("\n");
    }
    case "userPhone": {
      const display = (loc.displayPhone as string) ?? (loc.phone as string) ?? BUSINESS_PHONE;
      const base = display
        ? `Phone: please expect/call ${display}.`
        : "Phone: we'll confirm the number to expect.";
      if (guestPhone) return `${base} We'll call you at ${guestPhone}.`;
      return base;
    }
  }
}

export function locationBlockHtml(loc: ChosenLocation, guestPhone?: string | null): string {
  switch (loc.type) {
    case "integrations:daily":
      return loc.url
        ? `<p>Video (Daily.co): <a href="${loc.url}">${loc.url}</a></p>`
        : `<p>Video (Daily.co): link to follow</p>`;
    case "inPerson": {
      const addr = (loc.address as string) ?? BUSINESS_ADDRESS;
      let html = `<p>In person — Brick House Blue, Hilliard`;
      if (addr) html += `<br>${addr}`;
      if (BUSINESS_MAPS_URL) html += `<br><a href="${BUSINESS_MAPS_URL}">View map</a>`;
      if (!addr && !BUSINESS_MAPS_URL) html += `<br>Contact us for location details.`;
      return `${html}</p>`;
    }
    case "userPhone": {
      const display = (loc.displayPhone as string) ?? (loc.phone as string) ?? BUSINESS_PHONE;
      const base = display
        ? `<p>Phone: please expect/call ${display}.</p>`
        : `<p>Phone: we'll confirm the number to expect.</p>`;
      if (guestPhone) return `${base}<p>We'll call you at ${guestPhone}.</p>`;
      return base;
    }
  }
}

export interface ConfirmationInput {
  result: BookingResult;
  guestPhone?: string | null;
}

export function buildConfirmationEmail(input: ConfirmationInput): { subject: string; text: string; html: string } {
  const { result, guestPhone } = input;
  const loc = result.location;
  const when = `${result.startUtc} → ${result.endUtc} UTC`;
  const textLoc = loc ? locationBlockText(loc, guestPhone) : "";
  const htmlLoc = loc ? locationBlockHtml(loc, guestPhone) : "";

  const subject = `Confirmed: ${when}`;
  const text =
    `Your booking is confirmed.\n` +
    `When: ${when}\n` +
    (textLoc ? `\n${textLoc}\n` : "") +
    (guestPhone && loc?.type === "userPhone" ? "" : "");
  const html =
    `<p>Your booking is confirmed.</p>` +
    `<p>When: ${when}</p>` +
    (htmlLoc || "");
  return { subject, text, html };
}

// AgentMail seam — replace with real AgentMail call when wired.
// Currently logs so video vs office vs phone is unambiguous in confirmation.
export async function sendBookingConfirmation(input: ConfirmationInput): Promise<void> {
  const { subject, text, html } = buildConfirmationEmail(input);
  // TODO: wire AgentMail send here. For now, log so behavior is visible and testable.
  console.log(`[AgentMail] ${subject}\n${text}\n---HTML---\n${html}`);
}
