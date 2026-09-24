// robots.txt — the indexing directive this app did not have.
//
// WHY (closing report M8 / fix queue row 17, 2026-08-22): a lost pet's public
// credential renders the owner's first name, phone (`tel:` link and all) and
// last known location, and there was no indexing directive in ANY of the five
// possible places — no robots.ts, no robots.txt, an `X-Robots-Tag` scoped to
// /denuncias only, nothing in page or layout metadata, no headers block in
// vercel.json. The `no-store` that IS set is a CACHE directive; Google honours
// `noarchive`/`nosnippet` for retention, not `no-store`.
//
// WHAT THIS FILE DOES AND DOES NOT DECIDE. Lost pets STAY indexable — that is
// settled (PII audit 2026-07-04 rated the sitemap's lost-pet line Info,
// "expected for reunification SEO"), and being findable is the whole point of
// the surface. The retention half is what this fixes, and it is fixed by the
// `X-Robots-Tag: noarchive, nosnippet` on `/p/:path*` in next.config.ts, not
// here. This file's job is narrower: declare the sitemap so the daily lost-pet
// feed is actually announced, and keep crawlers out of the surfaces that were
// never meant to be walked.
//
// NOTE the refuted premise, so nobody "fixes" it again: the sitemap is NOT the
// vector. `/perdidas` is in the site-wide footer and its cards link straight to
// each credential, so a crawler arrives by following links whether or not the
// sitemap lists anything. Deleting the sitemap entry would have changed nothing.

import type { MetadataRoute } from "next";

// Same resolution rule as app/sitemap.ts: NEXT_PUBLIC_SITE_URL is the single
// source of truth for the public origin. Unlike the sitemap this NEVER throws —
// a robots.txt that 500s is read by crawlers as "no restrictions", which is
// strictly worse than one built without a Sitemap: line.
function resolveSiteUrl(): string | null {
  const url = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return url ? url : null;
}

export default function robots(): MetadataRoute.Robots {
  const siteUrl = resolveSiteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        // Everything public is open on purpose: the credential (/p), the lost
        // board (/perdidas), adoption (/adoptar), shelters (/refugios) and the
        // institutional pages are the reunification and transparency surfaces.
        allow: "/",
        disallow: [
          // Signed-in product. Nothing here resolves for an anonymous crawler
          // anyway; listing it saves the crawl budget and the 302 noise.
          "/inicio",
          "/mis-mascotas",
          "/mis-turnos",
          "/notificaciones",
          "/cuenta",
          "/cuidado",
          "/transferencias",
          "/turnos",
          // Operator consoles.
          "/admin",
          "/gob",
          "/org",
          // Auth funnels — indexing a login form only ever produces confusing
          // results for someone searching for the product.
          "/iniciar-sesion",
          "/login",
          "/registro",
          "/signup",
          "/recuperar",
          "/auth",
          "/acceso-denegado",
          // Denuncia private surfaces. Already carry
          // `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`; this is the
          // belt to that pair of braces, because a header only reaches a crawler
          // that already requested the URL. /denuncias and /denuncias/nueva stay
          // crawlable ON PURPOSE — someone searching for how to report cruelty
          // needs to find the form.
          "/denuncias/codigo",
          "/denuncias/seguimiento",
          // Capability-bearing links. A shared libreta URL or a scan redirect is
          // a bearer token in a path; it must never end up in an index.
          //
          // THE TRAILING SLASH IS THE RULE, NOT STYLE. A robots.txt Disallow is
          // a PREFIX match on the raw path (RFC 9309 §2.2.2), not a segment
          // match. These two read "/t" and "/r" until 2026-09-18, and "/r"
          // matched "/refugios" — so the sitemap below listed every verified
          // shelter at priority 0.8 and this file told crawlers not to fetch a
          // single one of them, three lines under the comment that names
          // /refugios as open on purpose (audit A03-G1). "/t" would have done
          // the same to any future /t… page. `__tests__/sitemap-robots.test.ts`
          // checks every URL the sitemap emits against this list.
          "/libreta",
          "/t/",
          "/r/",
          // JSON surfaces. /api/v1 is a public read API, but a crawler indexing
          // JSON envelopes helps nobody and the page is the canonical rendering.
          "/api",
          // Internal design/reference pages.
          "/design",
          "/mantenimiento",
        ],
      },
    ],
    ...(siteUrl ? { sitemap: `${siteUrl}/sitemap.xml` } : {}),
  };
}
