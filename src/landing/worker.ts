// Stateless static-router worker for the getupcoming.app landing surface.
// No DB client, no secrets, no cron — nothing here can leak or redeploy the
// API worker. Deployed with `npx wrangler deploy -c wrangler-landing.toml`.
import {
  fallbackPage,
  holdPage,
  notFoundPage,
  privacyPage,
  resetPasswordPage,
  termsPage,
} from "./templates";

export interface LandingEnv {
  // Empty = serve the branded hold page at `/`. Set to the live Play Store URL
  // to flip `/` to a 302 redirect at publication (wrangler var, no code change).
  PLAY_STORE_URL?: string;
}

const APEX_HOST = "getupcoming.app";
const WWW_HOST = `www.${APEX_HOST}`;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function handleRequest(request: Request, env: LandingEnv): Response {
  const url = new URL(request.url);

  // www → apex (301), any path. One reviewable file keeps all surface logic.
  if (url.hostname.toLowerCase() === WWW_HOST) {
    url.hostname = APEX_HOST;
    return Response.redirect(url.toString(), 301);
  }

  const path = url.pathname;

  if (path === "/") {
    if (env.PLAY_STORE_URL) return Response.redirect(env.PLAY_STORE_URL, 302);
    return html(holdPage());
  }

  if (path === "/privacy") return html(privacyPage());
  if (path === "/terms") return html(termsPage());
  if (path === "/reset-password") return html(resetPasswordPage());

  if (path === "/.well-known/assetlinks.json") {
    // Placeholder statement — the real Android App Links JSON lands with the
    // signing-cert fingerprint task. Empty list declares no links.
    return new Response("[]\n", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Reserved single-use / share-link space: /{username} and /{username}/{slug}?lid=…
  // These URLs are minted and shared today (src/worker.ts) and currently hit a
  // DNS-dead host — a branded fallback makes them resolve to something sane.
  // Deliberately do NOT echo the `lid` token back into the page.
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1) {
    return html(fallbackPage({ username: segments[0], playStoreUrl: env.PLAY_STORE_URL }));
  }
  if (segments.length === 2) {
    return html(
      fallbackPage({
        username: segments[0],
        slug: segments[1],
        playStoreUrl: env.PLAY_STORE_URL,
      }),
    );
  }

  return html(notFoundPage(), 404);
}

export default {
  fetch(request: Request, env: LandingEnv): Response {
    return handleRequest(request, env);
  },
};