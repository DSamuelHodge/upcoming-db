/**
 * Live Daily.co API tests. Self-skip without DAILY_API_KEY — same pattern as
 * the live Turso suite. Every test cleans up the rooms it creates.
 */
import { randomUUID } from "crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDailyRoom, deleteDailyRoom, getDailyRoomUrl, roomNameFromUrl } from "./daily";

function live(name: string, fn: (t: object) => Promise<void> | void) {
  test(name, { skip: !process.env.DAILY_API_KEY && "Set DAILY_API_KEY to run live Daily.co tests" }, fn);
}

function shortName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

live("createDailyRoom mints a real room and returns its URL", async () => {
  const name = shortName("mint");
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const url = await createDailyRoom(name, nowSec, nowSec + 600);
    assert.ok(url, "expected a room URL");
    assert.equal(roomNameFromUrl(url), name);
  } finally {
    await deleteDailyRoom(name);
  }
});

live("minting an existing name recovers the same URL (idempotent)", async () => {
  const name = shortName("dup");
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const first = await createDailyRoom(name, nowSec, nowSec + 600);
    assert.ok(first);
    const second = await createDailyRoom(name, nowSec, nowSec + 600);
    assert.equal(second, first, "duplicate-name mint must recover the original URL");
  } finally {
    await deleteDailyRoom(name);
  }
});

live("deleteDailyRoom removes the room (404 afterwards)", async () => {
  const name = shortName("del");
  const nowSec = Math.floor(Date.now() / 1000);
  const url = await createDailyRoom(name, nowSec, nowSec + 600);
  assert.ok(url);
  assert.equal(await deleteDailyRoom(name), true);
  assert.equal(await getDailyRoomUrl(name), null, "room should be gone after delete");
});

live("deleteDailyRoom on a nonexistent name succeeds (404 tolerated)", async () => {
  assert.equal(await deleteDailyRoom(shortName("ghost")), true);
});

live("missing key soft-fails to null (no network)", async () => {
  const saved = process.env.DAILY_API_KEY;
  delete process.env.DAILY_API_KEY;
  try {
    const url = await createDailyRoom(shortName("nokey"), 0, 60);
    assert.equal(url, null);
  } finally {
    process.env.DAILY_API_KEY = saved;
  }
});

live("invalid key fails against the real API (401) and soft-fails", async () => {
  const saved = process.env.DAILY_API_KEY;
  process.env.DAILY_API_KEY = "invalid-key-for-negative-test";
  try {
    const url = await createDailyRoom(shortName("badkey"), 0, 60);
    assert.equal(url, null);
  } finally {
    process.env.DAILY_API_KEY = saved;
  }
});

live("request timeout soft-fails against a blackhole endpoint", async () => {
  const savedBase = process.env.DAILY_API_BASE_URL;
  const savedTimeout = process.env.DAILY_TIMEOUT_MS;
  // Non-routable address: the request hangs until the timeout fires.
  process.env.DAILY_API_BASE_URL = "https://10.255.255.1/v1";
  process.env.DAILY_TIMEOUT_MS = "750";
  try {
    const url = await createDailyRoom(shortName("slow"), 0, 60);
    assert.equal(url, null);
  } finally {
    if (savedBase === undefined) delete process.env.DAILY_API_BASE_URL;
    else process.env.DAILY_API_BASE_URL = savedBase;
    if (savedTimeout === undefined) delete process.env.DAILY_TIMEOUT_MS;
    else process.env.DAILY_TIMEOUT_MS = savedTimeout;
  }
});

live("roomNameFromUrl extracts names and rejects non-https", () => {
  assert.equal(roomNameFromUrl("https://my-team.daily.co/room-name"), "room-name");
  assert.equal(roomNameFromUrl("http://my-team.daily.co/room-name"), null);
  assert.equal(roomNameFromUrl("not a url"), null);
});
