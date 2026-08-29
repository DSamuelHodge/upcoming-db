// Thin HTTP layer over the handler functions — the deployment target is
// Cloudflare Workers. Handlers stay untouched; this file only:
//   - validates the caller's bearer secret (per Docs/api-contract.md auth model)
//   - maps errors through mapErrorToHttp (409/404/400, else generic 500)
//   - performs read-only SQL for list/detail endpoints (sanctioned read path)
//   - relays Stripe REST calls for the paid-booking flow (secret key never
//     leaves this process)
import { Hono, type Context } from "hono";
import { and, asc, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { DateTime } from "luxon";
import * as schema from "./schema";
import {
  cancelBookingHandler,
  createBookingHandler,
  makeTxRepository,
  mapErrorToHttp,
} from "./create-booking-handler";
import { EventTypeNotFoundError, loadEventType } from "./event-types";
import { computeMultiHostAvailability } from "./multi-host-routing";
import { UserMetadata, parseUserMetadata, stringifyUserMetadata } from "./user-metadata";
import { encryptToken, decryptToken } from "./crypto";
import { z } from "zod";

export interface WorkerEnv {
  LIBSQL_URL?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  API_SECRET?: string;
  DAILY_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
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

export interface AppDeps {
  db?: AppDb;
  stripeSecretKey?: string;
}

export function createApp(env: WorkerEnv, deps: AppDeps = {}) {
  const app = new Hono();

  const stripeKey = deps.stripeSecretKey ?? env.STRIPE_SECRET_KEY;

  let db: AppDb;
  if (deps.db) {
    db = deps.db;
  } else {
    const url = resolveDbUrl(env);
    let cached = dbCache.get(url);
    if (!cached) {
      const client = createClient(
        env.TURSO_AUTH_TOKEN ? { url, authToken: env.TURSO_AUTH_TOKEN } : { url }
      );
      cached = drizzle(client, { schema });
      dbCache.set(url, cached);
    }
    db = cached;
  }

  // Wraps a route body in the shared error contract.
  const guarded =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
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

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const auth = c.req.header("Authorization") ?? "";
    const expected = `Bearer ${env.API_SECRET ?? ""}`;
    if (!env.API_SECRET || auth !== expected) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Reads (sanctioned read-only SQL path)
  // ---------------------------------------------------------------------------

  app.get(
    "/event-types",
    guarded(async () => {
      const rows = await db
        .select()
        .from(schema.eventTypes)
        .where(eq(schema.eventTypes.isActive, true))
        .orderBy(asc(schema.eventTypes.id));
      const hosts = await db.select().from(schema.eventTypeHosts).orderBy(asc(schema.eventTypeHosts.priority));
      return Response.json(
        rows.map((et) => ({
          ...et,
          hostUserIds: hosts.filter((h) => h.eventTypeId === et.id).map((h) => h.hostUserId),
        }))
      );
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

  const loadTargetUser = async (
    c: Context
  ): Promise<
    { error: Response; user?: undefined } | { error?: undefined; user: typeof schema.users.$inferSelect }
  > => {
    const userIdParam = c.req.query("userId");
    const userId = userIdParam ? Number(userIdParam) : undefined;
    if (userIdParam && (!Number.isInteger(userId) || (userId as number) <= 0)) {
      return { error: await Response.json({ error: "userId must be a positive integer" }, { status: 400 }) };
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

  const meResponse = async (user: typeof schema.users.$inferSelect) => {
    const [schedule] = await db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.userId, user.id))
      .limit(1);
    return Response.json({
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
    });
  };

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
      return Response.json({ ...result, replay: result.replay ?? false }, { status: 200 });
    })
  );

  app.post(
    "/bookings/cancel",
    guarded(async (c) => {
      const result = await cancelBookingHandler(db, await c.req.json());
      return Response.json(result);
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
      return Response.json({ uid: body.uid, paid: true, paymentIntentId: body.paymentIntentId });
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
};

export default worker;
