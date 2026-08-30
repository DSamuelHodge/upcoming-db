import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptToken, encryptToken } from "./crypto";

function withKey<T>(key: string, fn: () => T): T {
  const prev = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = prev;
  }
}

const HEX_KEY = "a".repeat(64);
const B64_KEY = Buffer.alloc(32, 7).toString("base64");

test("token roundtrip with hex and base64 keys", () => {
  withKey(HEX_KEY, () => {
    const envelope = encryptToken("ya29.secret-token-1");
    assert.match(envelope, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.equal(decryptToken(envelope), "ya29.secret-token-1");
  });
  withKey(B64_KEY, () => {
    const envelope = encryptToken("oauth2.refresh");
    assert.equal(decryptToken(envelope), "oauth2.refresh");
  });
});

test("each encryption uses a fresh IV", () => {
  withKey(HEX_KEY, () => {
    const a = encryptToken("same");
    const b = encryptToken("same");
    assert.notEqual(a, b);
    assert.equal(decryptToken(a), "same");
    assert.equal(decryptToken(b), "same");
  });
});

test("tampered ciphertext or auth tag fails authentication", () => {
  withKey(HEX_KEY, () => {
    const envelope = encryptToken("payload");
    const [, iv, tag, data] = envelope.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    const tampered = `v1:${iv}:${tag}:${flipped.toString("base64")}`;
    assert.throws(() => decryptToken(tampered));

    const otherTag = Buffer.from(tag, "base64");
    otherTag[0] ^= 0xff;
    assert.throws(() => decryptToken(`v1:${iv}:${otherTag.toString("base64")}:${data}`));
  });
});

test("wrong or missing key throws", () => {
  withKey(HEX_KEY, () => {
    const envelope = encryptToken("payload");
    withKey("b".repeat(64), () => {
      assert.throws(() => decryptToken(envelope));
    });
    const prev = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      assert.throws(() => encryptToken("x"), /TOKEN_ENCRYPTION_KEY is not set/);
      assert.throws(() => decryptToken(envelope), /TOKEN_ENCRYPTION_KEY is not set/);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = prev;
    }
  });
});

test("malformed envelope is rejected without touching the key", () => {
  withKey(HEX_KEY, () => {
    assert.throws(() => decryptToken("not-an-envelope"), /Unrecognized token envelope/);
    assert.throws(() => decryptToken("v2:a:b:c"), /Unrecognized token envelope/);
  });
});

test("keys that do not decode to 32 bytes are rejected", () => {
  assert.throws(() => withKey("short", () => encryptToken("x")), /must decode to 32 bytes/);
  assert.throws(() => withKey(Buffer.alloc(16).toString("hex"), () => encryptToken("x")), /must decode to 32 bytes/);
});
