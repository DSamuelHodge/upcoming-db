/**
 * Daily.co room management. Only used when location.type === "integrations:daily".
 *
 * Room policy: per-booking rooms are minted with the booking uid as the room
 * name and an nbf/exp join window around the slot (plus a grace period), so
 * rooms self-expire and need no garbage collection. Rooms created with a name
 * that already exists are recovered via GET /rooms/{name}, which makes minting
 * idempotent for retried/replayed booking attempts.
 *
 * All failures are soft: callers receive null (create) or false (delete) and
 * the booking flow continues. Every request is bounded by a timeout.
 *
 * Configuration (all optional):
 * - DAILY_API_KEY (required to talk to Daily; unset = everything soft-fails)
 * - DAILY_API_BASE_URL (default https://api.daily.co/v1)
 * - DAILY_ROOM_PRIVACY (default public)
 * - DAILY_ROOM_GRACE_SECONDS (default 3600; how long past slot end the room stays joinable)
 * - DAILY_TIMEOUT_MS (default 10000)
 */
import { logInfo, logWarn } from "./logger";

function apiBase(): string {
  return process.env.DAILY_API_BASE_URL ?? "https://api.daily.co/v1";
}

function timeoutMs(): number {
  return Number(process.env.DAILY_TIMEOUT_MS ?? 10_000);
}

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

async function fetchJson(path: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${apiBase()}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs()) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function getRoomUrl(roomName: string, apiKey: string): Promise<string | null> {
  const { status, body } = await fetchJson(`/rooms/${roomName}`, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  if (status !== 200) return null;
  const url = (body as { url?: string } | null)?.url;
  return url ?? null;
}

/** Mint a room. Returns its URL, or null on any failure (soft-fail). */
export async function createDailyRoom(
  roomName: string,
  nbfSeconds: number,
  expSeconds: number
): Promise<string | null> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    logWarn("daily_api_key_missing", { roomName });
    return null;
  }
  try {
    const { status, body } = await fetchJson("/rooms", {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        name: roomName,
        privacy: process.env.DAILY_ROOM_PRIVACY ?? "public",
        properties: { nbf: nbfSeconds, exp: expSeconds },
      }),
    });
    if (status === 200) {
      const url = (body as { url?: string } | null)?.url;
      if (url) {
        logInfo("daily_room_created", { roomName, url });
        return url;
      }
    }
    // A room with this name already exists (retried/replayed attempt): recover
    // the existing URL instead of failing — minting is idempotent by name.
    if (status === 409 || (await recoverableDuplicate(status, roomName, apiKey))) {
      const existing = await getRoomUrl(roomName, apiKey);
      if (existing) return existing;
    }
    logWarn("daily_room_create_failed", { roomName, status });
    return null;
  } catch (err) {
    logWarn("daily_room_create_error", { roomName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function recoverableDuplicate(status: number, roomName: string, apiKey: string): Promise<boolean> {
  if (status !== 400) return false;
  // Daily reports duplicate names with a 400 + "already exists" body.
  try {
    const res = await fetch(`${apiBase()}/rooms/${roomName}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs()),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Best-effort room teardown. 404 counts as success (already gone). */
export async function deleteDailyRoom(roomName: string): Promise<boolean> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    logWarn("daily_api_key_missing", { roomName });
    return false;
  }
  try {
    const { status } = await fetchJson(`/rooms/${roomName}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    if (status === 200 || status === 404) return true;
    logWarn("daily_room_delete_failed", { roomName, status });
    return false;
  } catch (err) {
    logWarn("daily_room_delete_error", { roomName, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Live lookup used by tests (and available for ops checks). */
export async function getDailyRoomUrl(roomName: string): Promise<string | null> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) return null;
  try {
    return await getRoomUrl(roomName, apiKey);
  } catch {
    return null;
  }
}

/** Extract the room name from a Daily room URL; null if not a https URL. */
export function roomNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return parsed.pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}
