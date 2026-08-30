// Static HTML for the getupcoming.app landing surface. Inline CSS, system
// fonts, zero external requests, zero trackers. Privacy/terms are DRAFT text
// (captain + legal review gate, see remediation-plan/report) — keep them as
// easy-to-edit constants until the gate clears.

const ACCENT = "#CC785C";

const STYLE = `
  :root { color-scheme: light dark; --accent: ${ACCENT}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #1c1b1a;
    background: #faf9f7;
    min-height: 100vh;
  }
  main { max-width: 640px; margin: 0 auto; padding: 4rem 1.5rem 5rem; }
  .brand { font-size: 1.9rem; font-weight: 700; letter-spacing: -0.02em; margin: 0; }
  .brand .dot { color: var(--accent); }
  .tagline { color: #6b6864; margin: 0.75rem 0 0; }
  .card {
    background: #fff; border: 1px solid #ece9e4; border-radius: 12px;
    padding: 1.5rem; margin-top: 2rem;
  }
  .card h2 { margin: 0 0 0.5rem; font-size: 1.1rem; letter-spacing: -0.01em; }
  .card p { margin: 0.5rem 0; }
  .banner {
    background: #fff3d6; color: #7a4b00; border-bottom: 2px solid #e0a800;
    padding: 0.75rem 1.5rem; font-weight: 700; text-align: center;
    letter-spacing: 0.02em;
  }
  .button {
    display: inline-block; background: var(--accent); color: #fff;
    padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none;
    font-weight: 600; margin-top: 1rem;
  }
  .muted { color: #6b6864; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
  h1 { letter-spacing: -0.01em; }
  section { margin-top: 1.75rem; }
  section h2 { font-size: 1.05rem; letter-spacing: -0.01em; }
  footer { color: #8a8681; font-size: 0.85rem; margin-top: 2.5rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e6e3; background: #171513; }
    .card { background: #201e1b; border-color: #2e2b28; }
    .tagline, .muted { color: #a7a29c; }
    footer { color: #8a8681; }
    .banner { background: #2e2410; color: #f0c878; border-color: #8a6d1a; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(opts: { title: string; body: string; draftBanner?: boolean }): string {
  const banner = opts.draftBanner
    ? `<div class="banner">DRAFT — NOT YET REVIEWED</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
${banner}
<main>
${opts.body}
<footer>Upcoming · <a class="muted" href="https://getupcoming.app">getupcoming.app</a></footer>
</main>
</body>
</html>`;
}

export function holdPage(): string {
  return layout({
    title: "Upcoming",
    body: `
<h1 class="brand">Upcoming<span class="dot">.</span></h1>
<p class="tagline">Schedule meetings, manage availability, send calendar links.</p>
<div class="card">
  <h2>Coming soon to Google Play</h2>
  <p class="muted">The Upcoming app is on its way. Booking and share links
  (like the one you may have just opened) will open right in the app.</p>
  <p class="muted">Questions? <a href="mailto:support@getupcoming.app">support@getupcoming.app</a></p>
</div>`,
  });
}

export function fallbackPage(opts: {
  username: string;
  slug?: string;
  playStoreUrl?: string;
}): string {
  const target = opts.slug
    ? `/${escapeHtml(opts.username)}/${escapeHtml(opts.slug)}`
    : `/${escapeHtml(opts.username)}`;
  const cta = opts.playStoreUrl
    ? `<a class="button" href="${escapeHtml(opts.playStoreUrl)}">Get the app</a>`
    : `<p class="muted">Coming soon on Google Play.</p>`;
  return layout({
    title: "Open in Upcoming",
    body: `
<h1 class="brand">Upcoming<span class="dot">.</span></h1>
<p class="tagline">This is a booking link, not a webpage.</p>
<div class="card">
  <h2>This link opens in the Upcoming app</h2>
  <p>Link: <span class="mono">${escapeHtml(target)}</span></p>
  <p class="muted">Upcoming lets you see the person's availability and book a
  time. Open this link on your phone once the app is installed.</p>
  ${cta}
</div>`,
  });
}

export function resetPasswordPage(): string {
  return layout({
    title: "Reset password",
    body: `
<h1>Reset your password</h1>
<div class="card">
  <h2>Password resets happen by email</h2>
  <p class="muted">For now, credential resets go through email — check your inbox
  for a reset link. This page is a placeholder; no token is required here.</p>
</div>`,
  });
}

export function notFoundPage(): string {
  return layout({
    title: "Page not found",
    body: `
<h1>Page not found</h1>
<div class="card">
  <p class="muted">That page doesn't exist. It may be a booking link — those open
  in the Upcoming app.</p>
  <a class="button" href="/">Go to the homepage</a>
</div>`,
  });
}

// --- DRAFT legal text (roadmap Phase 0 inputs; NOT reviewed) ---

export function privacyPage(): string {
  return layout({
    title: "Privacy Policy — Upcoming",
    draftBanner: true,
    body: `
<h1>Privacy Policy</h1>
<p class="muted">Last updated: 2026-08-30</p>
<section>
  <h2>What we collect</h2>
  <p>We collect the information you provide when you use Upcoming: your email
  address, your timezone, the bookings you make or are invited to, and the event
  types you create (title, description, duration, and availability).</p>
</section>
<section>
  <h2>Storage</h2>
  <p>App data is stored locally on your device using the Android Room database and
  app preferences, and synced to Upcoming's backend, which is hosted on
  Cloudflare.</p>
</section>
<section>
  <h2>Third parties</h2>
  <p>We rely on a small number of service providers to operate the product:
  Stripe for payments, Daily.co for video meetings, and Cloudflare for backend
  hosting. Each processes data only to provide its service.</p>
</section>
<section>
  <h2>Retention &amp; deletion</h2>
  <p>Your data is deleted when you log out or delete your account. Local data is
  cleared from the device on logout.</p>
</section>
<section>
  <h2>Contact</h2>
  <p>Questions about this policy: <a href="mailto:support@getupcoming.app">support@getupcoming.app</a>.</p>
</section>`,
  });
}

export function termsPage(): string {
  return layout({
    title: "Terms of Service — Upcoming",
    draftBanner: true,
    body: `
<h1>Terms of Service</h1>
<p class="muted">Last updated: 2026-08-30</p>
<section>
  <h2>Payments</h2>
  <p>Paid bookings are processed by Stripe. By purchasing, you agree to Stripe's
  terms and to pay the price shown at the time of booking.</p>
</section>
<section>
  <h2>Cancellation</h2>
  <p>You may cancel bookings and delete your account at any time. Refunds of
  processed payments are provided only where required by applicable law.</p>
</section>
<section>
  <h2>Liability</h2>
  <p>The service is provided "as is" and "as available" without warranties.
  To the maximum extent permitted by law, Upcoming's liability is limited.</p>
</section>
<section>
  <h2>Your data rights (GDPR)</h2>
  <p>If you are in the EEA or UK, you have the right to access, rectify, erase,
  restrict, and export your personal data. Contact
  <a href="mailto:support@getupcoming.app">support@getupcoming.app</a> to exercise these rights.</p>
</section>`,
  });
}