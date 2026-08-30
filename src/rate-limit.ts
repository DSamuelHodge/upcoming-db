import type { MiddlewareHandler } from "hono";

/**
 * Per-IP rate limiting (2026-08-30). Sliding-window counters held in isolate
 * memory — an anti-scraping backstop, not a volumetric DoS control (the
 * authoritative control there is a Cloudflare WAF rate-limiting rule on the
 * zone). Limits are per IP per tier; windows are per isolate, which under
 * approximates a global limit — the safe direction.
 *
 * /health is exempt so uptime checks are never throttled.
 */

export interface RateLimitWindow {
  limit: number;
  windowMs: number;
}

export interface RateLimitTier extends RateLimitWindow {
  name: string;
  matches: (method: string, path: string) => boolean;
}

/** First match wins; unmatched requests fall to DEFAULT_LIMIT. */
export const RATE_LIMIT_TIERS: RateLimitTier[] = [
  {
    name: "auth",
    limit: 10,
    windowMs: 60_000,
    matches: (m, p) => m === "POST" && p.startsWith("/auth/"),
  },
  {
    name: "availability",
    limit: 50,
    windowMs: 60_000,
    matches: (m, p) => m === "GET" && p === "/availability",
  },
  {
    name: "booking-write",
    limit: 20,
    windowMs: 60_000,
    matches: (m, p) => m === "POST" && p.startsWith("/bookings"),
  },
  {
    name: "payments",
    limit: 20,
    windowMs: 60_000,
    matches: (m, p) => m === "POST" && p.startsWith("/payments/"),
  },
];

export const DEFAULT_LIMIT: RateLimitWindow = { limit: 100, windowMs: 60_000 };

export interface ResolvedRateLimitTier extends RateLimitWindow {
  name: string;
}

export function resolveTier(method: string, path: string): ResolvedRateLimitTier {
  const bare = path.split("?")[0]!;
  const tier = RATE_LIMIT_TIERS.find((t) => t.matches(method, bare));
  if (tier) return { name: tier.name, limit: tier.limit, windowMs: tier.windowMs };
  return { name: "default", ...DEFAULT_LIMIT };
}

/**
 * Client IP as seen by Cloudflare's edge. `CF-Connecting-IP` is set by the
 * edge itself and cannot be spoofed through it; the forwarded fallback is for
 * non-CF test setups only.
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "unknown";
}

const MAX_TRACKED_KEYS = 5_000;

export interface RateLimiter {
  hit: (key: string, window: RateLimitWindow) => { ok: boolean; retryAfterSec: number };
}

/** Sliding-window counter store. State lives in the closure — one per isolate. */
export function createRateLimiter(): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, { limit, windowMs }) {
      const now = Date.now();
      if (hits.size > MAX_TRACKED_KEYS) {
        for (const [k, arr] of hits) {
          const fresh = arr.filter((t) => now - t < windowMs);
          if (fresh.length === 0) hits.delete(k);
          else hits.set(k, fresh);
        }
      }
      const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (arr.length >= limit) {
        hits.set(key, arr);
        const oldest = arr[0]!;
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)) };
      }
      arr.push(now);
      hits.set(key, arr);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}

export function rateLimitMiddleware(options?: {
  limiter?: RateLimiter;
}): MiddlewareHandler {
  const limiter = options?.limiter ?? createRateLimiter();
  return async (c, next) => {
    if (c.req.path === "/health") return next();
    const tier = resolveTier(c.req.method, c.req.path);
    const key = `${clientIp(c.req.raw.headers)}:${tier.name}`;
    const verdict = limiter.hit(key, tier);
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfterSec));
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    await next();
  };
}
