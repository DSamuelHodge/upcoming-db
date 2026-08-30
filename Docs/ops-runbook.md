# Ops runbook — upcoming-db (production)

Concise launch-support notes. Complements `Docs/api-contract.md` §4 (HTTP
surface) and AGENTS.md (credentials + env gotchas). Hostnames follow the
redaction policy — live endpoints live in `.env` / `pass`, never here.

## 1. Production topology

| piece | value |
|---|---|
| Worker | `upcoming-db-api` (Hono, `src/worker.ts`) — official URL `https://api.getupcoming.app` (Workers custom domain on the `getupcoming.app` zone); `*.workers.dev` hostname secondary |
| Landing Worker | `upcoming-landing` (`src/landing/worker.ts`) — static surface on `getupcoming.app` + `www.getupcoming.app` (Workers custom domains); no DB, no secrets, no cron. Deploy: `npm run deploy:landing` (`npx wrangler deploy -c wrangler-landing.toml`) |
| DB | Turso instance `upcoming-db-v2` (group `default`, `aws-us-west-2`) |
| Cron | `*/15 * * * *` — reminder-push sweep (`scheduled()` in `src/worker.ts`; no-ops without `FCM_SERVICE_ACCOUNT`) |
| Deploy | manual: `npx wrangler deploy` from repo root on `main` (API worker) — landing changes never redeploy the API |

## 2. Backups & restore drill

- Turso keeps **point-in-time history** for every database; no snapshot job is
  needed from us. Verify any time with `turso db show upcoming-db-v2`.
- **Restore drill (do once before launch, quarterly after):**
  1. `turso db export upcoming-db-v2 --output /tmp/drill.tar.gz` (or
     `turso db shell upcoming-db-v2 .dump > /tmp/drill.sql` for a logical dump).
  2. Confirm the dump opens and contains the expected tables/rows:
     `sqlite3 /tmp/drill.db < /tmp/drill.sql && sqlite3 /tmp/drill.db "SELECT count(*) FROM bookings"`.
  3. Point-in-time restore into a NEW database (never in place):
     `turso db restore upcoming-db-v2-drill --timestamp <RFC3339> upcoming-db-v2`.
  4. Spot-check the restored DB, then `turso db destroy upcoming-db-v2-drill`
     (restore targets are separate databases; production is untouched).
- **Delete protection is ON** for `upcoming-db-v2` (2026-08-30). To destroy or
  reconfigure it you must first `turso db config delete-protection disable`.
- Nightly non-blocking drift guard (`npm run drift:check` in CI) catches
  schema divergence, not data loss — the drill above is the data-loss control.

## 3. Secrets inventory (wrangler secrets; `wrangler secret put <NAME>`)

| secret | purpose | notes |
|---|---|---|
| `API_SECRET` | legacy shared-secret admin (`authIsAdmin`) | operator/scripts only; **must never ship in a client binary** |
| `JWT_SECRET` | HS256 access-token signing | auth, 2026-08-29 |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | DB endpoint + DB-scoped token | token does not expire; rotate via `turso db tokens create upcoming-db-v2` |
| `DAILY_API_KEY` | Daily.co room mint/teardown | temp dev key in `.env`; real key here |
| `STRIPE_SECRET_KEY` | PaymentIntent create + mark-paid verification | test-mode for launch |
| `TOKEN_ENCRYPTION_KEY` | AES-256-GCM for `/me/credentials` at rest | 32-byte hex/base64 |
| `FCM_SERVICE_ACCOUNT` | FCM HTTP v1 push (lifecycle + reminder cron) | service-account key JSON (`project_id`, `client_email`, `private_key`). Unset = push disabled, cron no-ops. Setup: Google Cloud Console → IAM → Service Accounts → key (JSON); enable the Firebase Cloud Messaging API for the project. |

Rotate any secret with `wrangler secret put <NAME>` — deploys pick it up on
the next isolate spin-up; no redeploy required.

## 4. Rate limiting controls

| layer | where | tuning |
|---|---|---|
| WAF flood ceiling (authoritative, global per IP per colo) | zone `getupcoming.app` → Security → WAF → Rate limiting rules (`http_ratelimit` phase; rule id `1866625031b44d439fac90ea6b1e6318`) | 15 req/10s block 10s. Free plan = 1 rule; raise the plan for per-path edge rules |
| Worker tiers (per-endpoint, per-isolate) | `src/rate-limit.ts` (`RATE_LIMIT_TIERS`) | `/auth/*` 10/min · `/availability` 50/min · `POST /bookings*` + `/payments/*` 20/min · default 100/min; 429 + `Retry-After` |

The WAF ceiling above is scoped to `api.getupcoming.app` only — apex/`www`
landing traffic (the `upcoming-landing` worker) has **no per-IP flood ceiling**
(the free-plan 1-rule cap is already consumed). Accepted: the landing worker is
stateless, secretless, authless static content, and Cloudflare's managed L7 DDoS
protection still applies zone-wide. Triage "rate limit exceeded" on the landing
host against that (absent) layer, not the API ceiling.

In-isolate counters deliberately under-approximate global limits. If
per-endpoint global enforcement is ever required, add a Durable Object
limiter (post-launch upgrade — see api-contract §4.3).

## 5. Quick incident pointers

- **Bookings failing / 5xx spikes** → `curl -s https://api.getupcoming.app/health`;
  check `wrangler tail upcoming-db-api --format pretty`; check Turso status.
- **"Rate limit exceeded" reports** → confirm whether the 429 body is JSON
  (our worker tiers) or Cloudflare HTML (WAF ceiling); tune the matching layer.
- **Push not arriving** → is `FCM_SERVICE_ACCOUNT` set? (`wrangler tail` logs
  `fcm_send_failed` / `fcm_send_error` / `fcm_token_cleared`.) Test with:
  `curl -X POST -H "Authorization: Bearer $API_SECRET" https://api.getupcoming.app/push-reminders`
  → `{"sent":N,"checked":N}`.
- **Reminders not firing after reboot (Android side)** → that is the client
  reconciler (BootCompletedReceiver + WorkManager), tracked in the Android
  repo roadmap, not a backend concern.
