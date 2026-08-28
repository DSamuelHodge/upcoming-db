import { readFileSync } from "fs";

function getDailyApiKey(): string | undefined {
  if (process.env.DAILY_API_KEY) return process.env.DAILY_API_KEY;
  try {
    const txt = readFileSync(".env", "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*DAILY_API_KEY\s*=\s*(.*)\s*$/);
      if (m) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (v) return v;
      }
    }
  } catch {}
  return undefined;
}

/**
 * Daily.co room creation. Only called when location.type === "integrations:daily".
 * Room name is derived from booking uid (unique). nbf/exp are unix seconds around the slot.
 * Returns room url or null if DAILY_API_KEY missing or request fails.
 */
export async function createDailyRoom(
  roomName: string,
  nbfSeconds: number,
  expSeconds: number,
): Promise<string | null> {
  const apiKey = getDailyApiKey();
  if (!apiKey) {
    console.warn("[daily] DAILY_API_KEY not set; skipping Daily room creation for", roomName);
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
      console.warn("[daily] room create failed", res.status, body);
      return null;
    }
    const data = (await res.json()) as { url?: string };
    return data.url ?? null;
  } catch (err) {
    console.warn("[daily] room create error", err instanceof Error ? err.message : String(err));
    return null;
  }
}
