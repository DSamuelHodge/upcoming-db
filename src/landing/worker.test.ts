import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest, type LandingEnv } from "./worker";

const BASE = "https://getupcoming.app";

function get(path: string, env: LandingEnv = {}, host = BASE): Response {
  return handleRequest(new Request(new URL(path, host).toString()), env);
}

test("GET / serves the branded hold page when PLAY_STORE_URL is unset", async () => {
  const res = get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const text = await res.text();
  assert.match(text, /Upcoming/);
  assert.match(text, /Schedule meetings/);
});

test("GET / 302s to PLAY_STORE_URL when it is set", () => {
  const url = "https://play.google.com/store/apps/details?id=app.getupcoming";
  const res = get("/", { PLAY_STORE_URL: url });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), url);
});

test("www host 301s to apex, preserving path", () => {
  const res = handleRequest(
    new Request("https://www.getupcoming.app/alice/intro?lid=abc"),
    {},
  );
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "https://getupcoming.app/alice/intro?lid=abc");
});

test("GET /{username} renders a branded fallback", async () => {
  const res = get("/alice");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const text = await res.text();
  assert.match(text, /booking link/i);
  assert.match(text, /alice/);
});

test("GET /{username}/{slug} renders a branded fallback and never echoes the lid token", async () => {
  const res = get("/alice/intro?lid=sekret-token");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /booking link/i);
  assert.match(text, /alice/);
  assert.match(text, /intro/);
  assert.doesNotMatch(text, /sekret-token/);
});

test("GET /reset-password renders the placeholder", async () => {
  const res = get("/reset-password");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /password/i);
});

test("GET /.well-known/assetlinks.json returns JSON content-type and placeholder", async () => {
  const res = get("/.well-known/assetlinks.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await res.text()).trim(), "[]");
});

test("GET /privacy and /terms carry the visible DRAFT banner", async () => {
  for (const path of ["/privacy", "/terms"]) {
    const res = get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const text = await res.text();
    assert.match(text, /DRAFT/);
    assert.match(text, /NOT YET REVIEWED/);
  }
});

test("unknown paths fall through to a branded 404", async () => {
  const res = get("/a/b/c");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /not found/i);
});