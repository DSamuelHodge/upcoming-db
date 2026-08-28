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

const MAPS_URL = "https://maps.google.com/?q=4022+Green+Stripe+Lane+Hilliard+OH+43026";

export function locationBlockText(loc: ChosenLocation, guestPhone?: string | null): string {
  switch (loc.type) {
    case "integrations:daily":
      return loc.url ? `Video (Daily.co): ${loc.url}` : "Video (Daily.co): link to follow";
    case "inPerson": {
      const addr = (loc.address as string) ?? "4022 Green Stripe Lane, Hilliard, OH 43026";
      return `In person — Brick House Blue, Hilliard\n${addr}\nMap: ${MAPS_URL}`;
    }
    case "userPhone": {
      const display = (loc.displayPhone as string) ?? (loc.phone as string) ?? "(614) 407-4920";
      const base = `Phone: please expect/call ${display}.`;
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
      const addr = (loc.address as string) ?? "4022 Green Stripe Lane, Hilliard, OH 43026";
      return `<p>In person — Brick House Blue, Hilliard<br>${addr}<br><a href="${MAPS_URL}">View map</a></p>`;
    }
    case "userPhone": {
      const display = (loc.displayPhone as string) ?? (loc.phone as string) ?? "(614) 407-4920";
      const base = `<p>Phone: please expect/call ${display}.</p>`;
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
