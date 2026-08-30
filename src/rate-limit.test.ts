import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  clientIp,
  createRateLimiter,
  rateLimitMiddleware,
  resolveTier,
} from "./rate-limit";

function headersWith(ip?: string): Headers {
  const h = new Headers();
  if (ip) h.set("cf-connecting-ip", ip);
  return h;
}

test("resolveTier picks the first matching tier", () => {
  assert.equal(resolveTier("POST", "/auth/login").name, "auth");
  assert.equal(resolveTier("POST", "/auth/refresh").name, "auth");
  assert.equal(resolveTier("GET", "/auth/refresh").name, "default");
  assert.equal(resolveTier("GET", "/availability").name, "availability");
  assert.equal(resolveTier("GET", "/availability?x=1").name, "availability");
  assert.equal(resolveTier("POST", "/bookings").name, "booking-write");
  assert.equal(resolveTier("POST", "/bookings/cancel").name, "booking-write");
  assert.equal(resolveTier("POST", "/payments/create-intent").name, "payments");
  assert.equal(resolveTier("GET", "/event-types").name, "default");
  assert.equal(resolveTier("PATCH", "/event-types/3").name, "default");
  assert.equal(resolveTier("GET", "/health").name, "default");
});

test("clientIp prefers cf-connecting-ip, then first forwarded hop, then unknown", () => {
  assert.equal(clientIp(headersWith("1.2.3.4")), "1.2.3.4");
  const fwd = new Headers({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" });
  assert.equal(clientIp(fwd), "5.6.7.8");
  assert.equal(clientIp(new Headers()), "unknown");
});

test("rateLimiter allows up to limit then reports retry-after, sliding with the window", async () => {
  const limiter = createRateLimiter();
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.hit("ip-a:default", { limit: 3, windowMs: 40 }).ok, true);
  }
  const blocked = limiter.hit("ip-a:default", { limit: 3, windowMs: 40 });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(limiter.hit("ip-a:default", { limit: 3, windowMs: 40 }).ok, true);
});

test("rateLimiter buckets are independent per key", () => {
  const limiter = createRateLimiter();
  assert.equal(limiter.hit("ip-a:auth", { limit: 1, windowMs: 60_000 }).ok, true);
  assert.equal(limiter.hit("ip-a:auth", { limit: 1, windowMs: 60_000 }).ok, false);
  assert.equal(limiter.hit("ip-b:auth", { limit: 1, windowMs: 60_000 }).ok, true);
  assert.equal(limiter.hit("ip-a:default", { limit: 1, windowMs: 60_000 }).ok, true);
});

test("middleware returns 429 with Retry-After and error body, exempts /health", async () => {
  const app = new Hono();
  app.use("*", rateLimitMiddleware({ limiter: createRateLimiter() }));
  app.post("/auth/login", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));

  for (let i = 0; i < 10; i++) {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: headersWith("9.9.9.9"),
    });
    assert.equal(res.status, 200, `request ${i} should pass`);
  }
  const blocked = await app.request("/auth/login", {
    method: "POST",
    headers: headersWith("9.9.9.9"),
  });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  assert.deepEqual(await blocked.json(), { error: "rate limit exceeded" });

  const health = await app.request("/health");
  assert.equal(health.status, 200);
});

test("middleware keys buckets by client IP", async () => {
  const app = new Hono();
  app.use("*", rateLimitMiddleware({ limiter: createRateLimiter() }));
  app.post("/bookings", (c) => c.json({ ok: true }));

  for (let i = 0; i < 20; i++) {
    const res = await app.request("/bookings", {
      method: "POST",
      headers: headersWith("1.1.1.1"),
    });
    assert.equal(res.status, 200);
  }
  const blocked = await app.request("/bookings", { method: "POST", headers: headersWith("1.1.1.1") });
  assert.equal(blocked.status, 429);
  const other = await app.request("/bookings", { method: "POST", headers: headersWith("2.2.2.2") });
  assert.equal(other.status, 200);
});
