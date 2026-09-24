// Next.js middleware runs on every request that matches the `matcher` below.
// Its only job here is to call updateSession() so Supabase auth cookies stay
// fresh, and to redirect legacy paths so old bookmarks and external links
// continue to work.

import { canonicalDimToken } from "@/lib/domain/dim-token";
import { NO_STORE_CACHE_CONTROL, isPublicNoStoreRoute } from "@/lib/infra/public-cache-policy";
import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest, NextResponse } from "next/server";

// ── Content-Security-Policy (audit Item #64) ──────────────────────────────
// Shipped as REPORT-ONLY first. The browser observes and reports violations
// (to the console, and to a sink if one is ever added) but does NOT block
// anything, so a mistaken or too-strict directive cannot break the app before
// deploy — strictly safer than the current no-CSP state. Once a headless sweep
// of every page type reports zero violations, flip the response header name
// from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` to
// start enforcing.
//
// The nonce is PER-REQUEST, which is why the policy is assembled here in
// middleware and not in next.config.ts static headers (which cannot carry a
// per-request value). Next.js reads the nonce back out of the CSP request
// header — app-render.js accepts either `content-security-policy` OR
// `content-security-policy-report-only` — and stamps it onto every framework
// hydration/flight <script> automatically; `'strict-dynamic'` then extends
// trust to the chunk scripts those bootstrap scripts load. Our own inline
// <script>s (the two JSON-LD emitters under app/(public)/{refugios,adoptar})
// are NOT framework scripts, so they read the nonce from the `x-nonce` request
// header via headers() and set nonce={nonce} explicitly.

// Supabase origins are derived from the same env var next.config.ts uses, so
// local dev (http://127.0.0.1:54321 + ws) and any hosted project
// (https://<ref>.supabase.co + wss) are both covered without hardcoding a host.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const { supabaseHttpOrigin, supabaseWsOrigin } = (() => {
  try {
    const u = new URL(SUPABASE_URL);
    return {
      supabaseHttpOrigin: u.origin,
      supabaseWsOrigin: `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`,
    };
  } catch {
    return { supabaseHttpOrigin: "", supabaseWsOrigin: "" };
  }
})();

// Exported for the fence (__tests__/csp-dev-branch.test.ts): the `dev`
// parameter exists so BOTH directions are pinned — dev must carry the branch,
// production must never inherit it. Next.js allows extra exports here.
export function buildContentSecurityPolicy(
  nonce: string,
  dev: boolean = process.env.NODE_ENV === "development",
): string {
  return [
    // Default deny — any fetch directive without an explicit rule falls here.
    "default-src 'self'",
    // Scripts: same-origin + the per-request nonce only. 'strict-dynamic' lets
    // a nonce'd script load further chunks (Next hydration → app chunks)
    // without host allowlisting. No 'unsafe-inline' / no 'unsafe-eval' — in
    // PRODUCTION.
    //
    // THE DEV BRANCH (walkthrough 2026-08-31 §1, measured A/B on one commit):
    // `next dev` needs eval() for React Refresh, and Next reads the nonce off
    // this very policy and stamps it onto its scripts — so under dev the
    // policy without 'unsafe-eval' serves a web app whose client NEVER BOOTS:
    // flight payload present, zero `__reactFiber` on any node, and Server
    // Actions make the login work without JS, which disguises the corpse as
    // "my machine is broken". Every path this repo has for looking at the web
    // skips dev (NEXT_BUILT for Playwright, qa-up.ps1's production server,
    // staging for the clickthroughs), so nothing else could see it. DO NOT
    // LOOSEN PRODUCTION: the branch is keyed to the build mode, and the fence
    // pins both directions.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Styles: Tailwind utility classes and styled-jsx inject inline <style> and
    // style="" at runtime, which a nonce cannot cover — 'unsafe-inline' for
    // STYLES ONLY is the accepted trade-off (inline styles cannot execute JS).
    "style-src 'self' 'unsafe-inline'",
    // Images: pet photos + org logos from Supabase Storage (http in local dev,
    // https in prod), map raster tiles (https:), inline data: URIs (QR/icons),
    // and blob: previews (client-side image crops).
    ["img-src", "'self'", "data:", "blob:", "https:", supabaseHttpOrigin]
      .filter(Boolean)
      .join(" "),
    // maplibre-gl runs its tile/geometry pipeline in a Web Worker.
    //
    // `blob:` IS NO LONGER THE PATH TAKEN, and the note is kept rather than the
    // allowance removed. v5 laundered its worker through a Blob URL; v6 fetches
    // a real same-origin URL (/maplibre/maplibre-gl-worker.mjs) and only falls
    // back to a Blob when the worker URL is CROSS-origin, which ours is not.
    // Nothing else in this app constructs a Worker. So `blob:` here is an
    // allowance nobody currently uses.
    //
    // It stays because removing it is a separate judgement with a runtime risk
    // this change did not measure: a dependency that creates a worker on some
    // path we did not exercise would fail at the CSP, in production, silently
    // enough. Narrowing it deserves its own change and its own verification,
    // not a line stolen from a map fix.
    "worker-src 'self' blob:",
    // XHR/fetch/WebSocket: Supabase REST+Auth and realtime (ws/wss), plus the
    // OpenStreetMap raster tiles maplibre fetches for the location-capture maps
    // (LocationMap/LocationPicker). The panorama choropleth is tiles-free and
    // fetches its geojson same-origin ('self').
    [
      "connect-src",
      "'self'",
      supabaseHttpOrigin,
      supabaseWsOrigin,
      "https://*.supabase.co",
      "wss://*.supabase.co",
      "https://tile.openstreetmap.org",
    ]
      .filter(Boolean)
      .join(" "),
    // Fonts: self-hosted, plus any data: URI fonts.
    "font-src 'self' data:",
    // Clickjacking: disallow framing entirely (mirrors X-Frame-Options: DENY).
    "frame-ancestors 'none'",
    // Remaining injection surfaces.
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  // NOTE: no report-uri/report-to — no report sink exists yet. Report-only
  // still surfaces every violation to the browser console, which is what the
  // pre-enforcement headless sweep reads.
}

/**
 * The canonical `/p/{token}` path for a request, or `null` when there is
 * nothing to redirect (2026-09-23).
 *
 * WHY A REDIRECT AND NOT A FOLDING LOOKUP. A lowercase or space-padded token
 * (`/p/dim-pamp-0001`, a QR reader's trailing `%20`) names the same pet as the
 * issued `DIM-PAMP-0001`, and used to 404. The first fix folded case inside
 * the lookup predicate, and review turned it back: every limiter key on this
 * route family — the `/encontre` finder-possession buckets, the sighting and
 * dispute-tip write limiters, the `/api/v1` per-lookup key — and the scan log
 * are built from the RAW route param, so a folding predicate let one credential
 * be read under every case spelling, each with a fresh, empty limiter bucket,
 * and logged scans under names no pet has. Redirecting once, here, means
 * nothing downstream ever sees a non-canonical spelling.
 *
 * WHAT IS REDIRECTED. GET/HEAD only — a POST (a server action on these pages)
 * cannot follow a 308 without re-sending its body, and its arguments do not
 * come from the path anyway. The token segment is canonicalised by
 * `canonicalDimToken` (lib/domain/dim-token.ts): trim + ASCII-only uppercase,
 * and ONLY when the result has the token's shape. A lookalike (`dım-…`, Turkish
 * dotless i) or any other non-token is left alone to 404 as typed — a redirect
 * is a claim that the destination is the same resource. Any sub-path
 * (`/encontre`, `/sighting`, `/opengraph-image`) and the query string survive.
 */
export function canonicalPublicTokenRedirectPath(method: string, pathname: string): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  const match = pathname.match(/^\/p\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const [, rawSegment, rest = ""] = match;
  let segment: string;
  try {
    segment = decodeURIComponent(rawSegment);
  } catch {
    return null; // malformed escape: not a token, let the route 404 it
  }
  const canonical = canonicalDimToken(segment);
  if (canonical === null || canonical === segment) return null;
  return `/p/${canonical}${rest}`;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Per-request CSP nonce (Item #64). One nonce per request, shared by the
  // framework scripts and our JSON-LD emitters. Exposed two ways:
  //   • x-nonce request header — read by the JSON-LD server components.
  //   • the CSP request header — read by Next.js to nonce its own scripts.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildContentSecurityPolicy(nonce);
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy-report-only", csp);

  // Expose the request pathname to server components via a request header.
  // Server layouts (e.g. app/(public)/layout.tsx) cannot read usePathname(),
  // so the unified AppShell decision (resolveShellNav, Item 7) needs the path
  // at the layout boundary to pick the citizen vs landing chrome by route.
  // This is additive and side-effect-free — it never alters routing.
  request.headers.set("x-pathname", pathname);

  // Bug fix (qa-triage-2026-07-23, finding #13): pathname alone drops the
  // query string (e.g. /gob/denuncias?etapa=triage&queue=mine), so a guard
  // building a post-login `returnTo` from x-pathname ONLY would strand the
  // operator back at the bare stage/tab default instead of their exact deep
  // link. x-full-path carries pathname+search so lib/infra/auth-guards.ts's
  // guards (requireAdminOrGovtOrRedirect, requireAdminOrRedirect) can restore
  // the FULL attempted URL after a session-expiry bounce to /login.
  request.headers.set("x-full-path", `${pathname}${request.nextUrl.search}`);

  // Permanent redirect: /pro/* → /cuenta/memberships.
  // The /pro portal has been removed; vets now operate through /org/[orgToken].
  // This catches browser bookmarks and external links for 30-day grace.
  if (pathname === "/pro" || pathname.startsWith("/pro/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/cuenta/memberships";
    return NextResponse.redirect(url, { status: 308 });
  }

  // Permanent redirect: legacy /refugio/* → /org (the org picker).
  // We send the user to /org rather than attempting to reconstruct an
  // org-scoped URL because we don't have the orgToken in the old paths.
  if (pathname === "/refugio" || pathname.startsWith("/refugio/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/org";
    return NextResponse.redirect(url, { status: 308 });
  }

  // Portal-follows-viewer (2026-07-02): the shared work surfaces (cola,
  // usuarios, organizaciones, reglas, servicios) exist under BOTH /admin and
  // /gob — same page implementation, chrome from each segment's layout. The
  // old AC3-era /admin→/gob 308s for these paths are GONE: /admin/* now
  // serves real pages. Only the renamed jurisdicciones subtree still remaps.
  //
  // Pages/components build their internal links from this header so a viewer
  // browsing under /admin never silently lands in /gob chrome (and vice
  // versa). Set on the request so server components can read it via headers().
  request.headers.set("x-portal-base", pathname.startsWith("/admin") ? "/admin" : "/gob");

  // Permanent redirect: /admin/jurisdicciones/* -> /admin/reglas/* (the
  // surface was renamed by admin-rules-console R1.6; the CRUD subtree dropped
  // the trailing "/reglas" segment when it folded into the unified surface).
  // Portal-follows-viewer keeps the admin bookmark inside the admin portal.
  const jurisdiccionesMatch = pathname.match(
    /^\/admin\/jurisdicciones(?:\/([^/]+)\/([^/]+)\/([^/]+)\/reglas((?:\/.*)?))?$/,
  );
  if (jurisdiccionesMatch) {
    const [, country, province, locality, rest] = jurisdiccionesMatch;
    const url = request.nextUrl.clone();
    url.pathname = country
      ? `/admin/reglas/${country}/${province}/${locality}${rest ?? ""}`
      : "/admin/reglas";
    return NextResponse.redirect(url, { status: 308 });
  }

  // Permanent redirects: legacy pet-profile lens routes (/vacunas, /historial,
  // /libreta) → the two-face profile with the matching `?tab=` query.
  //
  // These three page.tsx files already call permanentRedirect() themselves
  // (see app/(app)/mis-mascotas/[publicToken]/{vacunas,historial,libreta}/page.tsx),
  // but that page-level call does NOT reliably produce an HTTP 308 in
  // production: the shared boundary at
  // app/(app)/mis-mascotas/[publicToken]/loading.tsx makes Next.js stream a
  // 200 shell first and perform the redirect client-side via RSC flight
  // data — with JavaScript disabled/broken the request just hangs on
  // "Cargando…" forever. Live QA caught this (engram #635). Handling the
  // redirect here, at the edge, guarantees a real 308 before the request
  // ever reaches the page — the page-level permanentRedirect() calls stay in
  // place as belt-and-suspenders in case this matcher/regex ever misses.
  //
  // Must be an EXACT match on the three known lens segments: `/vacunas` has
  // a real sibling page at `/vacunas/programar` (schedule-a-vaccine form)
  // that must NOT be redirected.
  const legacyPetLensMatch = pathname.match(
    /^\/mis-mascotas\/([^/]+)\/(vacunas|historial|libreta)$/,
  );
  if (legacyPetLensMatch) {
    const [, publicToken, tab] = legacyPetLensMatch;
    const url = request.nextUrl.clone();
    url.pathname = `/mis-mascotas/${publicToken}`;
    url.search = `?tab=${tab}`;
    return NextResponse.redirect(url, { status: 308 });
  }

  // Permanent redirect: a non-canonical public token spelling → the issued one
  // (`/p/dim-pamp-0001` → `/p/DIM-PAMP-0001`). See the function's docblock for
  // why this lives at the edge and not in the lookup predicate.
  const canonicalTokenPath = canonicalPublicTokenRedirectPath(request.method, pathname);
  if (canonicalTokenPath !== null) {
    const url = request.nextUrl.clone();
    url.pathname = canonicalTokenPath;
    return NextResponse.redirect(url, { status: 308 });
  }

  const response = await updateSession(request);

  // PO quick win V2 (2026-07-24): remember the last org a user entered, so
  // /org can sort it first on their next visit. Captured at the edge (every
  // request under /org/[orgToken]/*, whichever way the user arrived —
  // picker click, single-org auto-redirect, or a bookmarked deep link) rather
  // than in the org layout, since a Server Component render cannot set
  // cookies. This is a UX preference only, not an access grant: app/org/page.tsx
  // still re-checks the cookie's org against the caller's OWN already-fetched
  // membership list before using it — a stale/foreign token here just fails
  // that check silently.
  const orgTokenMatch = pathname.match(/^\/org\/([^/]+)/);
  if (orgTokenMatch) {
    response.cookies.set("dim_last_org", orgTokenMatch[1], {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 90, // ~90d
    });
  }

  // Enforcing: a headless CSP-violation sweep across every page type (public,
  // JSON-LD, maplibre map + OSM tiles, dashboards, print) returned ZERO
  // violations, so the policy is safe to enforce. The early redirect returns
  // above have no scriptable body, so they need no CSP.
  response.headers.set("Content-Security-Policy", csp);

  // Privacy-class fix (2026-07-07): public routes that render mutable,
  // privacy-sensitive state (QR credential /p, revocable libreta share, lost
  // listing, adoption listing, denuncia status) MUST never be retained by a
  // shared/CDN cache — a revoked share or a found pet was being served stale at
  // the exact shared URL. They already declare `dynamic = "force-dynamic"`;
  // this stamps the matching `Cache-Control: no-store` so no shared cache keeps
  // them. See lib/infra/public-cache-policy.ts for the allowlist + rationale.
  if (isPublicNoStoreRoute(pathname)) {
    response.headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every request except static files, image optimization, the
    // favicon, and any file with a recognizable extension (svg, png, jpg, ...).
    //
    // `maplibre/` is excluded by PATH rather than by extension, and the reason
    // is worth a line: the two files under it are `.mjs`, which this matcher's
    // extension list does not cover, so without this they would run the full
    // middleware — including the Supabase `auth.getUser()` round-trip in
    // lib/supabase/middleware.ts — on a static asset that needs no session. It
    // would also stamp a per-request nonce and any refresh `Set-Cookie` onto the
    // response, which makes it uncacheable by any shared cache and undoes the
    // Cache-Control entry next.config.ts gives it.
    "/((?!_next/static|_next/image|favicon.ico|maplibre/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
