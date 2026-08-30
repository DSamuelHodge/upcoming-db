/**
 * FCM push (2026-08-30) — HTTP v1 API authenticated with a service-account
 * JWT signed via WebCrypto (the firebase-admin SDK is Node-only and does not
 * run on Workers). All failures soft-fail like daily.ts: push is best-effort
 * and the booking flow never depends on it.
 *
 * Configuration (all optional; unset FCM_SERVICE_ACCOUNT disables push):
 * - FCM_SERVICE_ACCOUNT — service-account key JSON (project_id, client_email,
 *   private_key). Mint in Google Cloud Console → IAM → Service Accounts.
 * - FCM_API_BASE_URL    — default https://fcm.googleapis.com (test override)
 * - GOOGLE_TOKEN_URL    — default https://oauth2.googleapis.com/token (test override)
 * - FCM_TIMEOUT_MS      — default 10000
 *
 * Token storage: users.metadata.fcmToken (one token per user for v1; the app
 * overwrites on token refresh). A 404/403/410 from FCM (unregistered/invalid
 * token) clears the stored token so bounces don't accumulate.
 */
import { and, eq, gte, lte } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { DateTime } from "luxon";
import { logWarn } from "./logger";
import * as schema from "./schema";
import {
  DEFAULT_REMINDER_OFFSETS,
  parseUserMetadata,
  stringifyUserMetadata,
  UserMetadata,
} from "./user-metadata";

export interface FcmEnv {
  FCM_SERVICE_ACCOUNT?: string;
  FCM_API_BASE_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  FCM_TIMEOUT_MS?: string;
}

type AppDb = LibSQLDatabase<typeof schema>;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const fcmApiBase = (env: FcmEnv) => env.FCM_API_BASE_URL ?? "https://fcm.googleapis.com";
const tokenUrl = (env: FcmEnv) => env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const timeoutMs = (env: FcmEnv) => Number(env.FCM_TIMEOUT_MS ?? 10_000);

export function parseServiceAccount(raw: string): ServiceAccount {
  const sa = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!sa.project_id || !sa.client_email || !sa.private_key) {
    throw new Error("FCM_SERVICE_ACCOUNT JSON must include project_id, client_email, private_key");
  }
  return sa as ServiceAccount;
}

function pemToPkcs8Der(pem: string) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

function b64url(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwtAssertion(sa: ServiceAccount, env: FcmEnv, iatSec: number): Promise<string> {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUrl(env),
    iat: iatSec,
    exp: iatSec + 3600,
  };
  const payload = b64url(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Der(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(signature)}`;
}

// OAuth access tokens live ~1h; cache in module scope (per isolate) and
// refresh a minute early.
let fcmTokenCache: { token: string; expiresAtMs: number } | null = null;

/** Test seam: drop the cached OAuth token. */
export function resetFcmAuth(): void {
  fcmTokenCache = null;
}

async function getAccessToken(env: FcmEnv, sa: ServiceAccount): Promise<string> {
  if (fcmTokenCache && fcmTokenCache.expiresAtMs > Date.now() + 60_000) return fcmTokenCache.token;
  const assertion = await signJwtAssertion(sa, env, Math.floor(Date.now() / 1000));
  const res = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(timeoutMs(env)),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed (${res.status})`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("FCM token exchange returned no access_token");
  fcmTokenCache = {
    token: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

function readFcmToken(metadataRaw: string | null): string | undefined {
  if (!metadataRaw) return undefined;
  const parsed = UserMetadata.safeParse(JSON.parse(metadataRaw));
  return parsed.success ? parsed.data.fcmToken : undefined;
}

async function clearFcmToken(db: AppDb, userId: number, metadataRaw: string): Promise<void> {
  const parsed = UserMetadata.safeParse(JSON.parse(metadataRaw));
  if (!parsed.success) return;
  const { fcmToken: _drop, ...rest } = parsed.data;
  await db
    .update(schema.users)
    .set({ metadata: stringifyUserMetadata(rest) })
    .where(eq(schema.users.id, userId));
}

export interface PushNotification {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  sent: boolean;
  reason?: string;
}

export async function sendPushToUser(
  db: AppDb,
  env: FcmEnv,
  userId: number,
  notification: PushNotification
): Promise<PushResult> {
  try {
    if (!env.FCM_SERVICE_ACCOUNT) return { sent: false, reason: "push-not-configured" };
    const [user] = await db
      .select({ metadata: schema.users.metadata })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) return { sent: false, reason: "user-not-found" };
    const token = readFcmToken(user.metadata);
    if (!token) return { sent: false, reason: "no-token" };

    const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
    const accessToken = await getAccessToken(env, sa);
    const res = await fetch(
      `${fcmApiBase(env)}/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: notification.title, body: notification.body },
            data: notification.data ?? {},
          },
        }),
        signal: AbortSignal.timeout(timeoutMs(env)),
      }
    );
    if (res.ok) return { sent: true };
    if (res.status === 404 || res.status === 403 || res.status === 410) {
      await clearFcmToken(db, userId, user.metadata).catch(() => {});
      logWarn("fcm_token_cleared", { userId, status: res.status });
      return { sent: false, reason: "token-cleared" };
    }
    logWarn("fcm_send_failed", { userId, status: res.status });
    return { sent: false, reason: `http-${res.status}` };
  } catch (err) {
    logWarn("fcm_send_error", { userId, message: String(err).slice(0, 200) });
    return { sent: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// Booking lifecycle pushes — fired from the route handlers via waitUntil.
// ---------------------------------------------------------------------------

export type BookingPushAction = "booking.created" | "booking.cancelled" | "booking.paid" | "booking.rescheduled";

const PUSH_TITLES: Record<BookingPushAction, string> = {
  "booking.created": "New booking",
  "booking.cancelled": "Booking cancelled",
  "booking.paid": "Payment received",
  "booking.rescheduled": "Booking rescheduled",
};

async function formatForHost(db: AppDb, hostUserId: number, startTimeUtc: string): Promise<string> {
  const [host] = await db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, hostUserId))
    .limit(1);
  return DateTime.fromISO(startTimeUtc)
    .setZone(host?.timezone ?? "UTC")
    .toFormat("ccc, LLL d 'at' h:mm a");
}

/** Loads the booking by uid and pushes a lifecycle event to its host. */
export async function bookingEventPush(
  db: AppDb,
  env: FcmEnv,
  uid: string,
  action: BookingPushAction
): Promise<void> {
  try {
    if (!env.FCM_SERVICE_ACCOUNT) return;
    const [row] = await db
      .select({
        hostUserId: schema.bookings.hostUserId,
        startTime: schema.bookings.startTime,
        eventTypeId: schema.bookings.eventTypeId,
      })
      .from(schema.bookings)
      .where(eq(schema.bookings.uid, uid))
      .limit(1);
    if (!row) return;
    const [eventType] = await db
      .select({ name: schema.eventTypes.title })
      .from(schema.eventTypes)
      .where(eq(schema.eventTypes.id, row.eventTypeId))
      .limit(1);
    const when = await formatForHost(db, row.hostUserId, row.startTime);
    await sendPushToUser(db, env, row.hostUserId, {
      title: PUSH_TITLES[action],
      body: `${eventType?.name ?? "Event"} — ${when}`,
      data: { bookingUid: uid, action },
    });
  } catch (err) {
    logWarn("fcm_booking_push_error", { uid, action, message: String(err).slice(0, 200) });
  }
}

// ---------------------------------------------------------------------------
// Reminder sweep — cron-driven (wrangler.toml crons */15) and manually
// triggerable via POST /push-reminders (admin).
// ---------------------------------------------------------------------------

export const REMINDER_SWEEP_WINDOW_MS = 15 * 60_000;

export interface ReminderBooking {
  uid: string;
  hostUserId: number;
  eventTypeName: string;
  startTime: string;
}

export interface DueReminder {
  uid: string;
  userId: number;
  eventTypeName: string;
  offsetMin: number;
  fireAtIso: string;
}

/** Pure selection: reminders whose (start − offset) lands in [now, now+window). */
export function dueReminders(
  bookings: ReminderBooking[],
  offsetsByUser: Map<number, number[]>,
  nowMs: number,
  windowMs: number
): DueReminder[] {
  const out: DueReminder[] = [];
  for (const booking of bookings) {
    const start = Date.parse(booking.startTime);
    if (Number.isNaN(start)) continue;
    const offsets = offsetsByUser.get(booking.hostUserId) ?? [...DEFAULT_REMINDER_OFFSETS];
    for (const offsetMin of offsets) {
      const fire = start - offsetMin * 60_000;
      if (fire >= nowMs && fire < nowMs + windowMs) {
        out.push({
          uid: booking.uid,
          userId: booking.hostUserId,
          eventTypeName: booking.eventTypeName,
          offsetMin,
          fireAtIso: new Date(fire).toISOString(),
        });
      }
    }
  }
  return out;
}

function humanizeOffset(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} min`;
}

/** Reminder offsets from a user's metadata, tolerating malformed rows. */
function offsetsFromMetadata(metadataRaw: string): number[] {
  const parsed = UserMetadata.safeParse(JSON.parse(metadataRaw));
  return parsed.success ? (parsed.data.prefs?.reminderOffsets ?? [...DEFAULT_REMINDER_OFFSETS]) : [...DEFAULT_REMINDER_OFFSETS];
}

export async function runReminderSweep(
  db: AppDb,
  env: FcmEnv,
  nowMs: number = Date.now()
): Promise<{ sent: number; checked: number }> {
  if (!env.FCM_SERVICE_ACCOUNT) return { sent: 0, checked: 0 };
  const windowMs = REMINDER_SWEEP_WINDOW_MS;
  const maxOffsetMs = 10080 * 60_000; // ReminderOffsets cap: 7 days before start
  const rows = await db
    .select({
      uid: schema.bookings.uid,
      hostUserId: schema.bookings.hostUserId,
      startTime: schema.bookings.startTime,
      eventTypeName: schema.eventTypes.title,
    })
    .from(schema.bookings)
    .innerJoin(schema.eventTypes, eq(schema.bookings.eventTypeId, schema.eventTypes.id))
    .where(
      and(
        eq(schema.bookings.status, "accepted"),
        gte(schema.bookings.startTime, new Date(nowMs).toISOString()),
        lte(schema.bookings.startTime, new Date(nowMs + maxOffsetMs + windowMs).toISOString())
      )
    );
  const userIds = Array.from(new Set(rows.map((r) => r.hostUserId)));
  const offsetsByUser = new Map<number, number[]>();
  for (const userId of userIds) {
    const [user] = await db
      .select({ metadata: schema.users.metadata })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (user) offsetsByUser.set(userId, offsetsFromMetadata(user.metadata));
  }
  const targets = dueReminders(rows, offsetsByUser, nowMs, windowMs);
  let sent = 0;
  for (const target of targets) {
    const result = await sendPushToUser(db, env, target.userId, {
      title: `Upcoming: ${target.eventTypeName}`,
      body: `Starts in ${humanizeOffset(target.offsetMin)}`,
      data: {
        bookingUid: target.uid,
        action: "booking.reminder",
        offsetMin: String(target.offsetMin),
      },
    });
    if (result.sent) sent++;
  }
  return { sent, checked: targets.length };
}
