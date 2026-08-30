// Auth primitives (2026-08-29): scrypt password hashing + HS256 JWTs +
// refresh-token hashing. Runs under nodejs_compat (node:crypto available).
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { sign, verify } from "hono/jwt";

const SCRYPT_KEYLEN = 64;

// Stored as "s1:<salt-hex>:<hash-hex>". s1 = algorithm version.
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `s1:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [version, salt, hash] = stored.split(":");
  if (version !== "s1" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(candidate, expected);
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d

export interface AccessTokenPayload {
  sub: string; // user id
  iat: number;
  exp: number;
}

export async function signAccessToken(
  userId: number,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<string> {
  return sign(
    { sub: String(userId), iat: nowSeconds, exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS },
    secret,
    "HS256"
  );
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessTokenPayload> {
  return verify(token, secret, "HS256") as unknown as Promise<AccessTokenPayload>;
}

// Refresh tokens are 32 random bytes, url-safe. Only the SHA-256 lands in the
// sessions table — the raw token lives client-side only.
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
