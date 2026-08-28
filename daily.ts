/**
 * Daily.co room creation. Only called when location.type === "integrations:daily".
 * Room name is derived from booking uid (unique). nbf/exp are unix seconds around the slot.
 * Returns room url or null if DAILY_API_KEY missing or request fails.
 */
import { logWarn } from "./logger";

export async function createDailyRoom(
  roomName: string,
  nbfSeconds: number,
  expSeconds: number,
): Promise<string | null> {
  const apiKey = process.env.DAILY_API_KEY;
  if (!apiKey) {
    logWarn("daily_api_key_missing", { roomName });
    return null;
  }
  try {
    const res = await fetch("https://api.daily.co/v1/rooms", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: roomName,
        properties: { nbf: nbfSeconds, exp: expSeconds },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logWarn("daily_room_create_failed", { roomName, status: res.status, body });
      return null;
    }
    const data = (await res.json()) as { url?: string };
    return data.url ?? null;
  } catch (err) {
    logWarn("daily_room_create_error", { roomName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
