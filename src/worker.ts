// Thin HTTP layer over the handler functions — the deployment target is
// Cloudflare Workers. Handlers stay untouched; this file only:
//   - validates the caller's bearer secret (per Docs/api-contract.md auth model)
//   - maps errors through mapErrorToHttp (409/404/400, else generic 500)
//   - performs read-only SQL for list/detail endpoints (sanctioned read path)
//   - relays Stripe REST calls for the paid-booking flow (secret key never
//     leaves this process)
import { Hono, type Context } from "hono";

// Hono context variables set by the auth middleware.
export interface AppEnv {
  Variables: {
    authUserId?: number;
    authIsAdmin?: boolean;
  };
}
type AppContext = Context<AppEnv>;
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { rateLimitMiddleware } from "./rate-limit";
import { bookingEventPush, runReminderSweep } from "./fcm";
import { logError } from "./logger";
import { DateTime } from "luxon";
import * as schema from "./schema";
import {
  cancelBookingHandler,
  createBookingHandler,
  makeTxRepository,
  mapErrorToHttp,
  rescheduleBookingHandler,
} from "./create-booking-handler";
import { EventTypeNotFoundError, loadEventType } from "./event-types";
import { computeMultiHostAvailability } from "./multi-host-routing";
import { UserMetadata, parseUserMetadata, stringifyUserMetadata } from "./user-metadata";
import { encryptToken, decryptToken } from "./crypto";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from "./auth";
import { z } from "zod";

export interface WorkerEnv {
  LIBSQL_URL?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  API_SECRET?: string;
  JWT_SECRET?: string;
  DAILY_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  // FCM push (fcm.ts). Unset = push disabled; reminder cron no-ops.
  FCM_SERVICE_ACCOUNT?: string;
  FCM_API_BASE_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  FCM_TIMEOUT_MS?: string;
}

type AppDb = LibSQLDatabase<typeof schema>;

export function resolveDbUrl(env: WorkerEnv, allowSqliteFileUrls = false): string {
  const url = env.TURSO_DATABASE_URL || env.LIBSQL_URL;
  if (!url) {
    throw new Error("Set TURSO_DATABASE_URL or LIBSQL_URL");
  }
  if (
    !allowSqliteFileUrls &&
    (url.startsWith("file:") || url.startsWith("sqlite:") || /\.db(\b|$)/.test(url))
  ) {
    throw new Error(`Refusing SQLite file URL (${url}). Use a LibSQL/Turso instance.`);
  }
  return url;
}

// Clients are per-URL singletons: Workers reuse the isolate across requests,
// and @libsql/client manages its own connection pooling.
const dbCache = new Map<string, AppDb>();

export function getDb(env: WorkerEnv): AppDb {
  const url = resolveDbUrl(env);
  let cached = dbCache.get(url);
  if (!cached) {
    const client = createClient(
      env.TURSO_AUTH_TOKEN ? { url, authToken: env.TURSO_AUTH_TOKEN } : { url }
    );
    cached = drizzle(client, { schema });
    dbCache.set(url, cached);
  }
  return cached;
}

export interface AppDeps {
  db?: AppDb;
  stripeSecretKey?: string;
}

export function createApp(env: WorkerEnv, deps: AppDeps = {}) {
  const app = new Hono<AppEnv>();

  const stripeKey = deps.stripeSecretKey ?? env.STRIPE_SECRET_KEY;

  let db: AppDb;
  if (deps.db) {
    db = deps.db;
  } else {
    db = getDb(env);
  }

  // Wraps a route body in the shared error contract.
  const guarded =
    (fn: (c: AppContext) => Promise<Response>) =>
    async (c: AppContext): Promise<Response> => {
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof EventTypeNotFoundError) {
          return c.json({ error: err.message }, 404);
        }
        const mapping = mapErrorToHttp(err);
        return c.json({ error: mapping.message }, mapping.status as 400);
      }
    };

  // Post-response background work. Uses the runtime's waitUntil when available
  // (real Workers requests); falls back to a plain fire-and-forget promise in
  // test runners, where `c.executionCtx` is absent and would throw.
  const waitUntil = (c: AppContext, promise: Promise<unknown>): void => {
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      promise.catch(() => {});
    }
  };

  // Dual auth (2026-08-29):
  //   /health + /auth/* are open.
  //   A valid Bearer JWT authenticates as its `sub` user (authUserId).
  //   Otherwise the legacy shared API_SECRET is required — it acts as the
  //   admin/demo credential (authIsAdmin) and keeps invitee + demo flows
  //   working unchanged. JWTs are attempted first; a malformed/expired one
  //   falls through to the secret check (so a stale token with no secret
  //   configured still 401s).
  const OPEN_PATHS = new Set(["/health", "/auth/signup", "/auth/login", "/auth/refresh", "/auth/logout"]);
  // Rate limit before auth: unauthenticated floods must not reach auth/DB work.
  app.use("*", rateLimitMiddleware());
  app.use("*", async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (env.JWT_SECRET && token && token.split(".").length === 3) {
      try {
        const payload = await verifyAccessToken(token, env.JWT_SECRET);
        c.set("authUserId", Number(payload.sub));
        return next();
      } catch {
        // fall through to the shared-secret path
      }
    }
    const expected = `Bearer ${env.API_SECRET ?? ""}`;
    if (!env.API_SECRET || auth !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("authIsAdmin", true);
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Auth (2026-08-29) — JWT sign-up/login/refresh/logout. Open routes: they
  // mint the credentials everything else consumes. Requires env.JWT_SECRET.
  // ---------------------------------------------------------------------------

  const UsernameInput = z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/, "username may contain letters, digits, '.', '_', '-'");

  const SignupInput = z
    .object({
      email: z.string().email(),
      password: z.string().min(8).max(200),
      username: UsernameInput,
      displayName: z.string().max(120).optional(),
      timezone: z.string().optional(),
    })
    .strict();

  const LoginInput = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).strict();
  const RefreshInput = z.object({ refreshToken: z.string().min(1).max(200) }).strict();

  const nowIso = () => new Date().toISOString();
  const isoAfter = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  const issueSession = async (userId: number): Promise<{ accessToken: string; refreshToken: string }> => {
    const jwtSecret = env.JWT_SECRET;
    if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
    const refreshToken = generateRefreshToken();
    await db.insert(schema.sessions).values({
      userId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresUtc: isoAfter(REFRESH_TOKEN_TTL_SECONDS),
      createdUtc: nowIso(),
    });
    // Opportunistic cleanup of dead sessions (>7d past expiry or revoked).
    const staleCutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    await db
      .delete(schema.sessions)
      .where(or(lt(schema.sessions.expiresUtc, staleCutoff), isNotNull(schema.sessions.revokedUtc)))
      .catch(() => {});
    return { accessToken: await signAccessToken(userId, jwtSecret), refreshToken };
  };

  const validSession = async (refreshToken: string) => {
    const [row] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.refreshTokenHash, hashRefreshToken(refreshToken)))
      .limit(1);
    if (!row) return null;
    if (row.revokedUtc) return null;
    if (new Date(row.expiresUtc).getTime() <= Date.now()) return null;
    return row;
  };

  app.post(
    "/auth/signup",
    guarded(async (c) => {
      if (!env.JWT_SECRET) return c.json({ error: "auth not configured" }, 503);
      let input: z.infer<typeof SignupInput>;
      try {
        input = SignupInput.parse(await c.req.json());
      } catch (e) {
        return c.json({ error: `invalid input: ${(e as z.ZodError).issues?.[0]?.path?.join(".") ?? "body"}` }, 400);
      }
      const clash = await db
        .select({ id: schema.users.id, email: schema.users.email, username: schema.users.username })
        .from(schema.users)
        .where(or(eq(schema.users.email, input.email.toLowerCase()), eq(schema.users.username, input.username)));
      if (clash.some((u) => u.email === input.email.toLowerCase())) {
        return c.json({ error: "email already registered" }, 409);
      }
      if (clash.length > 0) {
        return c.json({ error: "username already taken" }, 409);
      }
      const [user] = await db
        .insert(schema.users)
        .values({
          email: input.email.toLowerCase(),
          username: input.username,
          displayName: input.displayName ?? "",
          timezone: input.timezone && isValidTimezone(input.timezone) ? input.timezone : "UTC",
          passwordHash: hashPassword(input.password),
        })
        .returning();
      const tokens = await issueSession(user.id);
      return c.json({ ...tokens, user: await mePayload(user) }, 201);
    })
  );

  app.post(
    "/auth/login",
    guarded(async (c) => {
      if (!env.JWT_SECRET) return c.json({ error: "auth not configured" }, 503);
      let input: z.infer<typeof LoginInput>;
      try {
        input = LoginInput.parse(await c.req.json());
      } catch {
        return c.json({ error: "invalid input" }, 400);
      }
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, input.email.toLowerCase()))
        .limit(1);
      // Uniform 401: never reveal whether the email exists.
      if (!user?.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
        return c.json({ error: "invalid email or password" }, 401);
      }
      const tokens = await issueSession(user.id);
      return c.json({ ...tokens, user: await mePayload(user) });
    })
  );

  app.post(
    "/auth/refresh",
    guarded(async (c) => {
      if (!env.JWT_SECRET) return c.json({ error: "auth not configured" }, 503);
      let input: z.infer<typeof RefreshInput>;
      try {
        input = RefreshInput.parse(await c.req.json());
      } catch {
        return c.json({ error: "invalid input" }, 400);
      }
      const session = await validSession(input.refreshToken);
      if (!session) return c.json({ error: "invalid or expired refresh token" }, 401);
      // Rotate: the presented token is consumed, a fresh pair is issued.
      await db
        .update(schema.sessions)
        .set({ revokedUtc: nowIso() })
        .where(eq(schema.sessions.id, session.id));
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1);
      if (!user) return c.json({ error: "user no longer exists" }, 401);
      const tokens = await issueSession(user.id);
      return c.json({ ...tokens, user: await mePayload(user) });
    })
  );

  app.post(
    "/auth/logout",
    guarded(async (c) => {
      let input: z.infer<typeof RefreshInput>;
      try {
        input = RefreshInput.parse(await c.req.json());
      } catch {
        return c.json({ error: "invalid input" }, 400);
      }
      const session = await validSession(input.refreshToken);
      if (session) {
        await db
          .update(schema.sessions)
          .set({ revokedUtc: nowIso() })
          .where(eq(schema.sessions.id, session.id));
      }
      return c.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------------
  // Event types — reads are sanctioned read-only SQL; create/update/delete are
  // owner-scoped mutations (JWT user must own the row; the shared secret alone
  // acts as admin and may target anything).
  // ---------------------------------------------------------------------------

  app.get(
    "/event-types",
    guarded(async (c) => {
      // By default every event type is returned (deactivated ones included, so
      // clients can list + re-activate them); ?activeOnly=true keeps the old
      // behavior. Inactive rows are owner-scoped: a JWT caller sees their own
      // deactivated types plus the cross-owner active catalog; the shared
      // secret (admin — no JWT subject) sees everything.
      const activeOnly = c.req.query("activeOnly") === "true";
      const jwtUserId = c.get("authUserId") as number | undefined;
      const scope = activeOnly
        ? eq(schema.eventTypes.isActive, true)
        : jwtUserId === undefined
          ? undefined
          : or(eq(schema.eventTypes.isActive, true), eq(schema.eventTypes.ownerUserId, jwtUserId));
      const rows = await db.select().from(schema.eventTypes).where(scope).orderBy(asc(schema.eventTypes.id));
      const hosts = await db.select().from(schema.eventTypeHosts).orderBy(asc(schema.eventTypeHosts.priority));
      return Response.json(
        rows.map((et) => ({
          ...et,
          hostUserIds: hosts.filter((h) => h.eventTypeId === et.id).map((h) => h.hostUserId),
        }))
      );
    })
  );

  const LocationsMenu = z.array(z.object({ type: z.string().min(1) }).passthrough());

  // `locations` may arrive as a real JSON array or as the JSON-encoded string
  // clients cache (both end up as the string column value).
  const locationsColumn = z.union([LocationsMenu, z.string()]).transform((v) =>
    typeof v === "string" ? LocationsMenu.parse(JSON.parse(v)) : v
  );

  const CreateEventTypeInput = z
    .object({
      slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
      title: z.string().min(1).max(200),
      description: z.string().max(4000).optional(),
      lengthMinutes: z.number().int().min(1).max(480),
      slotIntervalMinutes: z.number().int().min(1).max(480).nullish(),
      bufferBefore: z.number().int().min(0).max(480).optional(),
      bufferAfter: z.number().int().min(0).max(480).optional(),
      schedulingType: z.enum(["individual", "round_robin", "collective"]).optional(),
      locations: locationsColumn.optional(),
      minBookingNotice: z.number().int().min(0).max(10080).optional(),
      priceInCents: z.number().int().min(0).optional(),
      currency: z.string().regex(/^[a-z]{3}$/).optional(),
      colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      isActive: z.boolean().optional(),
      // Admin-only override of the owner (ignored for JWT callers).
      ownerUserId: z.number().int().positive().optional(),
    })
    .strict();

  const UpdateEventTypeInput = CreateEventTypeInput.omit({ ownerUserId: true })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: "at least one field to update is required" });

  // Renders Zod issues as "path: message"; top-level issues (empty path, e.g.
  // the empty-PATCH refine above) fall back to the bare message.
  const zodDetail = (err: z.ZodError) =>
    err.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join(", ");

  const eventTypePayload = async (row: typeof schema.eventTypes.$inferSelect) => {
    const hostRows = await db
      .select({ hostUserId: schema.eventTypeHosts.hostUserId })
      .from(schema.eventTypeHosts)
      .where(eq(schema.eventTypeHosts.eventTypeId, row.id))
      .orderBy(asc(schema.eventTypeHosts.priority));
    return { ...row, hostUserIds: hostRows.map((h) => h.hostUserId) };
  };

  const slugTaken = async (ownerUserId: number, slug: string, excludeId?: number) => {
    const rows = await db
      .select({ id: schema.eventTypes.id })
      .from(schema.eventTypes)
      .where(
        excludeId === undefined
          ? and(eq(schema.eventTypes.ownerUserId, ownerUserId), eq(schema.eventTypes.slug, slug))
          : and(eq(schema.eventTypes.ownerUserId, ownerUserId), eq(schema.eventTypes.slug, slug), ne(schema.eventTypes.id, excludeId))
      )
      .limit(1);
    return rows.length > 0;
  };

  app.post(
    "/event-types",
    guarded(async (c) => {
      // Parse the body first so a malformed request body is not misreported as
      // a malformed `locations` string (whose JSON.parse throws its own
      // SyntaxError from inside the schema's transform).
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "body must be valid JSON" }, 400);
      }
      let input: z.infer<typeof CreateEventTypeInput>;
      try {
        input = CreateEventTypeInput.parse(body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: `invalid input: ${zodDetail(err)}` }, 400);
        }
        if (err instanceof SyntaxError) return c.json({ error: "locations is not valid JSON" }, 400);
        throw err;
      }

      const jwtUserId = c.get("authUserId") as number | undefined;
      const isAdmin = c.get("authIsAdmin") === true;
      let ownerUserId: number | undefined = jwtUserId;
      if (ownerUserId === undefined && isAdmin && input.ownerUserId !== undefined) ownerUserId = input.ownerUserId;
      if (ownerUserId === undefined) {
        // Admin (shared secret) without an explicit owner: fall back to the
        // lowest-id user, matching /me's single-tenant resolution.
        const [first] = await db.select({ id: schema.users.id }).from(schema.users).orderBy(asc(schema.users.id)).limit(1);
        if (!first) return c.json({ error: "no users exist; cannot infer event type owner" }, 400);
        ownerUserId = first.id;
      }

      if (await slugTaken(ownerUserId, input.slug)) {
        return c.json({ error: "slug already in use for this owner" }, 409);
      }

      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.eventTypes)
          .values({
            ownerUserId,
            slug: input.slug,
            title: input.title,
            description: input.description ?? "",
            lengthMinutes: input.lengthMinutes,
            slotIntervalMinutes: input.slotIntervalMinutes ?? null,
            bufferBefore: input.bufferBefore ?? 0,
            bufferAfter: input.bufferAfter ?? 0,
            schedulingType: input.schedulingType ?? "individual",
            locations: input.locations ? JSON.stringify(input.locations) : "[]",
            minBookingNotice: input.minBookingNotice ?? 0,
            priceInCents: input.priceInCents ?? 0,
            currency: input.currency ?? "usd",
            colorHex: input.colorHex ?? "#CC785C",
            isActive: input.isActive ?? true,
          })
          .returning();
        // Uniform host model: every event type (including individual) gets a
        // host row; the owner hosts their own creation at priority 0.
        await tx.insert(schema.eventTypeHosts).values({ eventTypeId: row.id, hostUserId: ownerUserId!, priority: 0 });
        return row;
      });

      return Response.json(await eventTypePayload(created), { status: 201 });
    })
  );

  app.patch(
    "/event-types/:id",
    guarded(async (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id must be a positive integer" }, 400);
      const owned = await loadOwnedEventType(c, id);
      if (owned.error) return owned.error;

      // Same split as POST: body-parse failures are distinct from a malformed
      // `locations` string inside an otherwise valid body.
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "body must be valid JSON" }, 400);
      }
      let input: z.infer<typeof UpdateEventTypeInput>;
      try {
        input = UpdateEventTypeInput.parse(body);
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: `invalid input: ${zodDetail(err)}` }, 400);
        }
        if (err instanceof SyntaxError) return c.json({ error: "locations is not valid JSON" }, 400);
        throw err;
      }

      if (input.slug !== undefined && (await slugTaken(owned.data.row.ownerUserId, input.slug, id))) {
        return c.json({ error: "slug already in use for this owner" }, 409);
      }

      const [updated] = await db
        .update(schema.eventTypes)
        .set({
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.lengthMinutes !== undefined ? { lengthMinutes: input.lengthMinutes } : {}),
          ...(input.slotIntervalMinutes !== undefined ? { slotIntervalMinutes: input.slotIntervalMinutes ?? null } : {}),
          ...(input.bufferBefore !== undefined ? { bufferBefore: input.bufferBefore } : {}),
          ...(input.bufferAfter !== undefined ? { bufferAfter: input.bufferAfter } : {}),
          ...(input.schedulingType !== undefined ? { schedulingType: input.schedulingType } : {}),
          ...(input.locations !== undefined ? { locations: JSON.stringify(input.locations) } : {}),
          ...(input.minBookingNotice !== undefined ? { minBookingNotice: input.minBookingNotice } : {}),
          ...(input.priceInCents !== undefined ? { priceInCents: input.priceInCents } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          ...(input.colorHex !== undefined ? { colorHex: input.colorHex } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        })
        .where(eq(schema.eventTypes.id, id))
        .returning();

      return Response.json(await eventTypePayload(updated));
    })
  );

  app.delete(
    "/event-types/:id",
    guarded(async (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id must be a positive integer" }, 400);
      const owned = await loadOwnedEventType(c, id);
      if (owned.error) return owned.error;

      const [booking] = await db
        .select({ id: schema.bookings.id })
        .from(schema.bookings)
        .where(eq(schema.bookings.eventTypeId, id))
        .limit(1);
      if (booking) {
        return c.json({ error: "event type has bookings; deactivate it instead of deleting" }, 409);
      }

      await db.transaction(async (tx) => {
        await tx.delete(schema.singleUseLinks).where(eq(schema.singleUseLinks.eventTypeId, id));
        await tx.delete(schema.eventTypeHosts).where(eq(schema.eventTypeHosts.eventTypeId, id));
        await tx.delete(schema.eventTypes).where(eq(schema.eventTypes.id, id));
      });
      return c.json({ ok: true });
    })
  );

  // ---------------------------------------------------------------------------
  // User settings (/me) — profile, timezone, and the users.metadata contract
  // (user-metadata.ts). Target user is the lowest-id user unless ?userId= is
  // supplied (single-tenant deployments have exactly one).
  // ---------------------------------------------------------------------------

  const isValidTimezone = (tz: string) =>
    tz.length > 0 && DateTime.now().setZone(tz).isValid;

  const PatchMeInput = z
    .object({
      displayName: z.string().max(120).optional(),
      avatarUrl: z.string().max(2048).optional(),
      email: z.string().email().optional(),
      username: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/, "username may contain letters, digits, '.', '_', '-'")
        .optional(),
      timezone: z.string().optional(),
      metadata: UserMetadata.optional(),
    })
    .strict();

  const PatchScheduleInput = z
    .object({ name: z.string().min(1).max(120).optional(), timezone: z.string().optional() })
    .strict();

  // Target user resolution: a JWT-authenticated caller is always their own
  // user (403 on a mismatched ?userId=). The shared-secret admin path keeps
  // the legacy behavior — lowest-id user, or ?userId= override.
  const loadTargetUser = async (
    c: AppContext
  ): Promise<
    { error: Response; user?: undefined } | { error?: undefined; user: typeof schema.users.$inferSelect }
  > => {
    const jwtUserId = c.get("authUserId") as number | undefined;
    const isAdmin = c.get("authIsAdmin") === true;
    const userIdParam = c.req.query("userId");
    const userId = userIdParam ? Number(userIdParam) : undefined;
    if (userIdParam && (!Number.isInteger(userId) || (userId as number) <= 0)) {
      return { error: await Response.json({ error: "userId must be a positive integer" }, { status: 400 }) };
    }
    if (jwtUserId !== undefined) {
      if (userId !== undefined && userId !== jwtUserId) {
        return { error: await Response.json({ error: "forbidden: cannot access another user" }, { status: 403 }) };
      }
      const [self] = await db.select().from(schema.users).where(eq(schema.users.id, jwtUserId)).limit(1);
      if (!self) return { error: await Response.json({ error: "user no longer exists" }, { status: 404 }) };
      return { user: self };
    }
    if (userId && !isAdmin) {
      return { error: await Response.json({ error: "forbidden: ?userId= requires admin credentials" }, { status: 403 }) };
    }
    const [user] = await db
      .select()
      .from(schema.users)
      .where(userId ? eq(schema.users.id, userId) : undefined)
      .orderBy(asc(schema.users.id))
      .limit(1);
    if (!user) return { error: await Response.json({ error: "no users exist" }, { status: 404 }) };
    return { user };
  };

  const mePayload = async (user: typeof schema.users.$inferSelect) => {
    const [schedule] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.userId, user.id))
      .limit(1);
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      timezone: user.timezone,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      // Loud parse: malformed metadata stored by an old writer surfaces as a
      // 500 instead of silently rendering as empty settings.
      metadata: parseUserMetadata(user.metadata),
      schedule: schedule
        ? { id: schedule.id, name: schedule.name, timezone: schedule.timezone }
        : null,
    };
  };

  const meResponse = async (user: typeof schema.users.$inferSelect) => Response.json(await mePayload(user));

  app.get(
    "/me",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      return meResponse(target.user);
    })
  );

  app.patch(
    "/me",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      let input: z.infer<typeof PatchMeInput>;
      try {
        input = PatchMeInput.parse(await c.req.json());
      } catch (err) {
        if (err instanceof z.ZodError) {
          return Response.json(
            { error: `invalid input: ${err.issues.map((i) => i.path.join(".")).join(", ")}` },
            { status: 400 }
          );
        }
        throw err;
      }
      const fields = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      if (fields.length === 0) {
        return Response.json({ error: "no fields to update" }, { status: 400 });
      }
      if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
        return Response.json({ error: `unknown IANA timezone: ${input.timezone}` }, { status: 400 });
      }
      // Unique conflicts surfaced as 409 (pre-check + constraint backstop).
      if (input.email !== undefined) {
        const [clash] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.email, input.email), ne(schema.users.id, target.user.id)))
          .limit(1);
        if (clash) return Response.json({ error: "email already in use" }, { status: 409 });
      }
      if (input.username !== undefined) {
        const [clash] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.username, input.username), ne(schema.users.id, target.user.id)))
          .limit(1);
        if (clash) return Response.json({ error: "username already in use" }, { status: 409 });
      }
      try {
        await db
          .update(schema.users)
          .set({
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.username !== undefined ? { username: input.username } : {}),
            ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            ...(input.metadata !== undefined
              ? { metadata: stringifyUserMetadata(input.metadata) }
              : {}),
          })
          .where(eq(schema.users.id, target.user.id));
      } catch (err) {
        if (err instanceof Error && /UNIQUE/.test(err.message)) {
          return Response.json({ error: "email or username already in use" }, { status: 409 });
        }
        throw err;
      }
      const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, target.user.id)).limit(1);
      return meResponse(updated);
    })
  );

  app.patch(
    "/me/schedule",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      let input: z.infer<typeof PatchScheduleInput>;
      try {
        input = PatchScheduleInput.parse(await c.req.json());
      } catch (err) {
        if (err instanceof z.ZodError) {
          return Response.json(
            { error: `invalid input: ${err.issues.map((i) => i.path.join(".")).join(", ")}` },
            { status: 400 }
          );
        }
        throw err;
      }
      if (Object.keys(input).length === 0) {
        return Response.json({ error: "no fields to update" }, { status: 400 });
      }
      if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
        return Response.json({ error: `unknown IANA timezone: ${input.timezone}` }, { status: 400 });
      }
      // schedules.timezone is the availability source of truth; keep
      // users.timezone (display default) in lockstep in one transaction.
      await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.schedules)
          .where(eq(schema.schedules.userId, target.user.id))
          .limit(1);
        if (existing) {
          await tx
            .update(schema.schedules)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
            })
            .where(eq(schema.schedules.id, existing.id));
        } else {
          await tx.insert(schema.schedules).values({
            userId: target.user.id,
            name: input.name ?? "Working Hours",
            timezone: input.timezone ?? "UTC",
          });
        }
        if (input.timezone !== undefined) {
          await tx
            .update(schema.users)
            .set({ timezone: input.timezone })
            .where(eq(schema.users.id, target.user.id));
        }
      });
      const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, target.user.id)).limit(1);
      return meResponse(updated);
    })
  );

  // ---------------------------------------------------------------------------
  // User credentials (/me/credentials) — bring-your-own API keys and private
  // URLs (Daily.co key, iCal/CalDAV URLs, Stripe key, ...). Stored AES-256-GCM
  // envelope-encrypted in the credentials table; reads return masked hints
  // only — plaintext never leaves this process after the write.
  // ---------------------------------------------------------------------------

  const CREDENTIAL_TYPES = ["daily_api_key", "ical_url", "caldav_url", "stripe_secret_key"] as const;

  const maskSecret = (value: string): string => {
    if (value.length <= 4) return "••••";
    return `••••${value.slice(-4)}`;
  };

  app.get(
    "/me/credentials",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      const rows = await db
        .select({ type: schema.credentials.type, encryptedToken: schema.credentials.encryptedToken })
        .from(schema.credentials)
        .where(eq(schema.credentials.userId, target.user.id));
      return Response.json(
        rows.map((row) => {
          let hint = "••••";
          try {
            hint = maskSecret(decryptToken(row.encryptedToken));
          } catch {
            // Undecryptable (e.g. key rotated) — keep the generic mask.
          }
          return { type: row.type, hint };
        })
      );
    })
  );

  app.put(
    "/me/credentials/:type",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      const type = c.req.param("type") ?? "";
      if (!(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
        return Response.json({ error: `unknown credential type: ${type}` }, { status: 400 });
      }
      let body: { value: string };
      try {
        body = z.object({ value: z.string().min(1).max(4096) }).strict().parse(await c.req.json());
      } catch (err) {
        if (err instanceof z.ZodError) {
          return Response.json({ error: "body must be { value: string }" }, { status: 400 });
        }
        throw err;
      }
      // Light format validation per type — loud, but not a deep integration check.
      if (type === "ical_url" || type === "caldav_url") {
        if (!/^https?:\/\//.test(body.value)) {
          return Response.json({ error: `${type} must be an http(s) URL` }, { status: 400 });
        }
      }
      const encrypted = encryptToken(body.value);
      const [existing] = await db
        .select({ id: schema.credentials.id })
        .from(schema.credentials)
        .where(and(eq(schema.credentials.userId, target.user.id), eq(schema.credentials.type, type)))
        .limit(1);
      if (existing) {
        await db.update(schema.credentials).set({ encryptedToken: encrypted }).where(eq(schema.credentials.id, existing.id));
      } else {
        await db.insert(schema.credentials).values({ userId: target.user.id, type, encryptedToken: encrypted });
      }
      return Response.json({ type, hint: maskSecret(body.value) });
    })
  );

  app.delete(
    "/me/credentials/:type",
    guarded(async (c) => {
      const target = await loadTargetUser(c);
      if (target.error) return target.error;
      const type = c.req.param("type") ?? "";
      const deleted = await db
        .delete(schema.credentials)
        .where(and(eq(schema.credentials.userId, target.user.id), eq(schema.credentials.type, type)))
        .returning({ id: schema.credentials.id });
      if (deleted.length === 0) {
        return Response.json({ error: "credential not found" }, { status: 404 });
      }
      return Response.json({ deleted: type });
    })
  );

  app.get(
    "/bookings/:uid",
    guarded(async (c) => {
      const uid = c.req.param("uid") ?? "";
      const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.uid, uid)).limit(1);
      if (!booking) return Response.json({ error: "booking not found" }, { status: 404 });
      const [attendee] = await db
        .select()
        .from(schema.attendees)
        .where(eq(schema.attendees.bookingId, booking.id))
        .limit(1);
      const [eventType] = await db
        .select()
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.id, booking.eventTypeId))
        .limit(1);
      const hosts = await db
        .select()
        .from(schema.bookingHosts)
        .where(eq(schema.bookingHosts.bookingId, booking.id));
      return Response.json({
        ...booking,
        eventType: eventType ?? null,
        attendee: attendee ?? null,
        hostUserIds: [booking.hostUserId, ...hosts.map((h) => h.hostUserId)].filter(
          (v, i, a) => a.indexOf(v) === i
        ),
      });
    })
  );

  app.get(
    "/bookings",
    guarded(async (c) => {
      const hostUserId = c.req.query("hostUserId");
      const from = c.req.query("from");
      const to = c.req.query("to");
      const activeOnly = c.req.query("activeOnly") === "true";
      const conditions = [
        hostUserId ? eq(schema.bookings.hostUserId, Number(hostUserId)) : undefined,
        from ? gt(schema.bookings.endTime, from) : undefined,
        to ? lt(schema.bookings.startTime, to) : undefined,
        activeOnly ? inArray(schema.bookings.status, ["pending", "accepted"]) : undefined,
      ].filter((x): x is Exclude<typeof x, undefined> => x !== undefined);
      const rows = await db
        .select()
        .from(schema.bookings)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.bookings.startTime))
        .limit(200);
      return Response.json(rows);
    })
  );

  // ---------------------------------------------------------------------------
  // Availability + booking writes (handler logic, never raw SQL)
  // ---------------------------------------------------------------------------

  app.get(
    "/availability",
    guarded(async (c) => {
      const eventTypeId = Number(c.req.query("eventTypeId"));
      const rangeStartUtc = c.req.query("rangeStartUtc") ?? "";
      const rangeEndUtc = c.req.query("rangeEndUtc") ?? "";
      if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
        return Response.json({ error: "eventTypeId is required" }, { status: 400 });
      }
      const start = DateTime.fromISO(rangeStartUtc, { zone: "utc" });
      const end = DateTime.fromISO(rangeEndUtc, { zone: "utc" });
      if (!start.isValid || !end.isValid || !rangeStartUtc || !rangeEndUtc) {
        return Response.json({ error: "rangeStartUtc/rangeEndUtc must be ISO 8601 instants" }, { status: 400 });
      }
      // Clamp to the documented 60-day window so a caller cannot force the
      // engine into an unbounded day-walk.
      if (end.diff(start, "days").days > 60) {
        return Response.json({ error: "range may not exceed 60 days" }, { status: 400 });
      }
      const loaded = await loadEventType(db, eventTypeId);
      // "individual" flows through the routing layer's union path with its
      // single host; the label is passed through to the slots verbatim.
      const slots = await computeMultiHostAvailability(makeTxRepository(db), {
        eventTypeId,
        hostUserIds: loaded.hostUserIds,
        schedulingType: loaded.schedulingType,
        rangeStartUtc: rangeStartUtc,
        rangeEndUtc: rangeEndUtc,
      });
      return Response.json({ eventTypeId, slots });
    })
  );

  app.post(
    "/bookings",
    guarded(async (c) => {
      const result = await createBookingHandler(db, await c.req.json());
      // Normalize to the documented contract: first-time creates report
      // replay: false explicitly.
      waitUntil(c, bookingEventPush(db, env, result.uid, "booking.created").catch(() => {}));
      return Response.json({ ...result, replay: result.replay ?? false }, { status: 200 });
    })
  );

  app.post(
    "/bookings/cancel",
    guarded(async (c) => {
      const result = await cancelBookingHandler(db, await c.req.json());
      waitUntil(c, bookingEventPush(db, env, result.uid, "booking.cancelled").catch(() => {}));
      return Response.json(result);
    })
  );

  app.post(
    "/bookings/:uid/reschedule",
    guarded(async (c) => {
      const uid = c.req.param("uid") ?? "";
      if (!uid) return c.json({ error: "uid is required" }, 400);
      // Owner-scoping: admin bypasses, JWT must be host or event-type owner.
      // This keeps invitee-proposed negotiation future-work but prevents
      // one host from moving another host's bookings in multi-tenant deploys.
      const jwtUserId = c.get("authUserId") as number | undefined;
      const isAdmin = c.get("authIsAdmin") === true;
      if (jwtUserId !== undefined && !isAdmin) {
        const [booking] = await db.select().from(schema.bookings).where(eq(schema.bookings.uid, uid)).limit(1);
        if (!booking) return c.json({ error: "booking not found" }, 404);
        const [et] = await db.select({ ownerUserId: schema.eventTypes.ownerUserId }).from(schema.eventTypes).where(eq(schema.eventTypes.id, booking.eventTypeId)).limit(1);
        const isHost = booking.hostUserId === jwtUserId;
        const isOwner = et?.ownerUserId === jwtUserId;
        // Also allow any secondary host on a collective booking
        let isSecondary = false;
        if (!isHost && !isOwner) {
          const [sec] = await db
            .select({ id: schema.bookingHosts.id })
            .from(schema.bookingHosts)
            .where(and(eq(schema.bookingHosts.bookingId, booking.id), eq(schema.bookingHosts.hostUserId, jwtUserId)))
            .limit(1);
          isSecondary = !!sec;
        }
        if (!isHost && !isOwner && !isSecondary) {
          return c.json({ error: "forbidden: not the booking host or event type owner" }, 403);
        }
      }
      const body = await c.req.json();
      const result = await rescheduleBookingHandler(db, uid, body);
      waitUntil(c, bookingEventPush(db, env, result.uid, "booking.rescheduled").catch(() => {}));
      return Response.json(result);
    })
  );

  // ---------------------------------------------------------------------------
  // Single-use booking links (2026-08-30) — Calendly-style one-time links.
  // Owner-scoped: a JWT user may only manage links for event types they own
  // (the shared API_SECRET acts as admin). URLs use the official domain.
  // ---------------------------------------------------------------------------

  const SINGLE_USE_BASE_URL = "https://getupcoming.app";

  const singleUseStatus = (row: typeof schema.singleUseLinks.$inferSelect): string => {
    if (row.revokedUtc) return "revoked";
    if (row.usedUtc) return "used";
    if (row.expiresUtc && new Date(row.expiresUtc).getTime() <= Date.now()) return "expired";
    return "unused";
  };

  const singleUseLinkPayload = (
    row: typeof schema.singleUseLinks.$inferSelect,
    ownerUsername: string,
    eventSlug: string
  ) => ({
    id: row.id,
    token: row.token,
    url: `${SINGLE_USE_BASE_URL}/${ownerUsername}/${eventSlug}?lid=${row.token}`,
    eventTypeId: row.eventTypeId,
    createdAt: row.createdUtc,
    expiresAt: row.expiresUtc,
    usedAt: row.usedUtc,
    revokedAt: row.revokedUtc,
    status: singleUseStatus(row),
  });

  /** Resolves the event type + owner username for link URL construction, and
   *  enforces ownership. Returns the error Response on failure. */
  const loadOwnedEventType = async (
    c: AppContext,
    eventTypeId: number
  ): Promise<{ error: Response; data?: undefined } | { error?: undefined; data: { row: typeof schema.eventTypes.$inferSelect; ownerUsername: string } }> => {
    const [row] = await db.select().from(schema.eventTypes).where(eq(schema.eventTypes.id, eventTypeId)).limit(1);
    if (!row) return { error: await Response.json({ error: "event type not found" }, { status: 404 }) };
    const jwtUserId = c.get("authUserId") as number | undefined;
    if (c.get("authIsAdmin") !== true || jwtUserId !== undefined) {
      if (jwtUserId === undefined || row.ownerUserId !== jwtUserId) {
        return { error: await Response.json({ error: "forbidden: not the event type owner" }, { status: 403 }) };
      }
    }
    const [owner] = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, row.ownerUserId)).limit(1);
    return { data: { row, ownerUsername: owner?.username ?? "" } };
  };

  app.post(
    "/single-use-links",
    guarded(async (c) => {
      let body: { eventTypeId: number; count?: number; expiresInDays?: number };
      try {
        body = z
          .object({
            eventTypeId: z.number().int().positive(),
            count: z.number().int().min(1).max(50).optional(),
            expiresInDays: z.number().int().min(1).max(365).optional(),
          })
          .strict()
          .parse(await c.req.json());
      } catch (err) {
        if (err instanceof z.ZodError) {
          return c.json({ error: "body must be { eventTypeId, count?, expiresInDays? }" }, 400);
        }
        throw err;
      }
      const owned = await loadOwnedEventType(c, body.eventTypeId);
      if (owned.error) return owned.error;
      const count = body.count ?? 1;
      const expiresUtc = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 3600 * 1000).toISOString()
        : null;
      const rows = await db
        .insert(schema.singleUseLinks)
        .values(
          Array.from({ length: count }, () => ({
            token: generateRefreshToken(),
            eventTypeId: body.eventTypeId,
            createdByUserId: owned.data.row.ownerUserId,
            createdUtc: new Date().toISOString(),
            expiresUtc,
          }))
        )
        .returning();
      return Response.json(
        rows.map((row) => singleUseLinkPayload(row, owned.data.ownerUsername, owned.data.row.slug)),
        { status: 201 }
      );
    })
  );

  app.get(
    "/single-use-links",
    guarded(async (c) => {
      const eventTypeId = Number(c.req.query("eventTypeId"));
      if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
        return c.json({ error: "eventTypeId is required" }, 400);
      }
      const owned = await loadOwnedEventType(c, eventTypeId);
      if (owned.error) return owned.error;
      const rows = await db
        .select()
        .from(schema.singleUseLinks)
        .where(eq(schema.singleUseLinks.eventTypeId, eventTypeId))
        .orderBy(desc(schema.singleUseLinks.id))
        .limit(200);
      return Response.json(rows.map((row) => singleUseLinkPayload(row, owned.data.ownerUsername, owned.data.row.slug)));
    })
  );

  app.delete(
    "/single-use-links/:id",
    guarded(async (c) => {
      const id = Number(c.req.param("id"));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: "id must be a positive integer" }, 400);
      const [link] = await db.select().from(schema.singleUseLinks).where(eq(schema.singleUseLinks.id, id)).limit(1);
      if (!link) return c.json({ error: "single-use link not found" }, 404);
      const owned = await loadOwnedEventType(c, link.eventTypeId);
      if (owned.error) return owned.error;
      if (!link.revokedUtc) {
        await db
          .update(schema.singleUseLinks)
          .set({ revokedUtc: new Date().toISOString() })
          .where(eq(schema.singleUseLinks.id, id));
      }
      return Response.json({
        id,
        status: "revoked",
        url: singleUseLinkPayload(link, owned.data.ownerUsername, owned.data.row.slug).url,
      });
    })
  );

  // ---------------------------------------------------------------------------
  // Stripe paid-booking flow (test mode). The secret key stays here; clients
  // only ever see the PaymentIntent client_secret.
  // ---------------------------------------------------------------------------

  app.post(
    "/payments/create-intent",
    guarded(async (c) => {
      if (!stripeKey) return Response.json({ error: "Stripe not configured" }, { status: 503 });
      const body = await c.req.json<{ eventTypeId?: number }>();
      const eventTypeId = Number(body.eventTypeId);
      if (!Number.isInteger(eventTypeId) || eventTypeId <= 0) {
        return Response.json({ error: "eventTypeId is required" }, { status: 400 });
      }
      const [eventType] = await db
        .select({
          priceInCents: schema.eventTypes.priceInCents,
          currency: schema.eventTypes.currency,
          title: schema.eventTypes.title,
        })
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.id, eventTypeId))
        .limit(1);
      if (!eventType) return Response.json({ error: "event type not found" }, { status: 404 });
      if (eventType.priceInCents <= 0) {
        return Response.json({ error: "event type is free; no payment required" }, { status: 400 });
      }
      const params = new URLSearchParams({
        amount: String(eventType.priceInCents),
        currency: eventType.currency,
        description: `Upcoming booking: ${eventType.title || `event type ${eventTypeId}`}`,
        "automatic_payment_methods[enabled]": "true",
        // The Android SDK confirms cards in-app (no browser redirect); without
        // this Stripe refuses confirmation unless a return_url is supplied.
        "automatic_payment_methods[allow_redirects]": "never",
      });
      const res = await fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${stripeKey}:`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      const intent = (await res.json()) as {
        id?: string;
        client_secret?: string;
        error?: { message?: string };
      };
      if (!res.ok || !intent.id || !intent.client_secret) {
        return Response.json(
          { error: intent.error?.message ?? "Stripe PaymentIntent creation failed" },
          { status: 502 }
        );
      }
      return Response.json({
        paymentIntentId: intent.id,
        clientSecret: intent.client_secret,
        amount: eventType.priceInCents,
        currency: eventType.currency,
      });
    })
  );

  app.post(
    "/payments/mark-paid",
    guarded(async (c) => {
      if (!stripeKey) return Response.json({ error: "Stripe not configured" }, { status: 503 });
      const body = await c.req.json<{ uid?: string; paymentIntentId?: string }>();
      if (!body.uid || !body.paymentIntentId) {
        return Response.json({ error: "uid and paymentIntentId are required" }, { status: 400 });
      }
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(body.paymentIntentId)}`, {
        headers: { Authorization: `Basic ${btoa(`${stripeKey}:`)}` },
      });
      const intent = (await res.json()) as { status?: string; amount_received?: number; error?: { message?: string } };
      if (!res.ok) {
        return Response.json({ error: intent.error?.message ?? "Stripe lookup failed" }, { status: 502 });
      }
      if (intent.status !== "succeeded") {
        return Response.json(
          { error: `PaymentIntent status is '${intent.status}'; only 'succeeded' marks a booking paid` },
          { status: 402 }
        );
      }
      const updated = await db
        .update(schema.bookings)
        .set({ paid: true, paymentIntentId: body.paymentIntentId })
        .where(and(eq(schema.bookings.uid, body.uid), eq(schema.bookings.status, "accepted")))
        .returning({ uid: schema.bookings.uid });
      if (updated.length === 0) {
        return Response.json({ error: "accepted booking not found for uid" }, { status: 404 });
      }
      waitUntil(c, bookingEventPush(db, env, body.uid, "booking.paid").catch(() => {}));
      return Response.json({ uid: body.uid, paid: true, paymentIntentId: body.paymentIntentId });
    })
  );

  // ---------------------------------------------------------------------------
  // Push (2026-08-30) — manual reminder-sweep trigger for staging/tests.
  // The cron (wrangler.toml crons) runs the same sweep; both no-op without
  // FCM_SERVICE_ACCOUNT. Admin-only: the sweep fans out per-user reads.
  // ---------------------------------------------------------------------------
  app.post(
    "/push-reminders",
    guarded(async (c) => {
      if (c.get("authIsAdmin") !== true) {
        return c.json({ error: "admin only" }, 403);
      }
      return c.json(await runReminderSweep(db, env));
    })
  );

  return app;
}

// Workers entry point. `createBookingHandler` imports `crypto.randomUUID` and
// `daily.ts` reads `process.env.DAILY_API_KEY` at call time, so mirror the
// Workers env bindings into `process.env` under `nodejs_compat`.
const worker = {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
    g.process ??= {};
    g.process.env ??= {};
    if (env.DAILY_API_KEY) g.process.env.DAILY_API_KEY = env.DAILY_API_KEY;
    return createApp(env).fetch(req, env);
  },

  // Cron trigger (wrangler.toml: crons = ["*/15 * * * *"]) — reminder-push
  // sweep. Window math in fcm.ts makes each reminder fire in exactly one tick.
  async scheduled(
    _event: { cron: string },
    env: WorkerEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void }
  ): Promise<void> {
    ctx.waitUntil(
      runReminderSweep(getDb(env), env).catch((err) => {
        logError("fcm_reminder_sweep_failed", { message: String(err).slice(0, 200) });
      })
    );
  },
};

export default worker;
