// lib/demo-mode.ts — server-safe demo-mode flag helper.
//
// Lives OUTSIDE any "use client" module so the server-side admin layout can
// import it without crashing the /admin segment (regression fixed in WP0/A1).
// Both app/admin/layout.tsx (server) and components/ui/DemoModeBanner.tsx
// (client) import shouldShowDemoBanner from here — one source of truth.

/**
 * Returns true when the demo banner should be shown.
 *
 * Accepts the raw NEXT_PUBLIC_DEMO_MODE env string so it stays pure and
 * testable without the DOM or process.env. Only the exact string "true"
 * enables it — anything else (undefined, "false", "1", "TRUE") is off, so the
 * banner never appears in production by default.
 */
export function shouldShowDemoBanner(envValue: string | undefined): boolean {
  return envValue === "true";
}

// ---------------------------------------------------------------------------
// WHERE the banner belongs, which is a different question from WHETHER
// ---------------------------------------------------------------------------

/**
 * The public paths that carry NO records at all — legal text and product
 * description, rendered from constants, touching neither the database nor any
 * seeded figure.
 *
 * WHY AN EXEMPTION EXISTS AT ALL, because the banner's own header says
 * "inescapable" and that word was chosen on purpose.
 *
 * The disclosure makes a claim, and the claim is about DATA: "entorno de
 * demostración — datos sintéticos". It is TRUE of this deployment and measured,
 * not assumed — 41.377 pets against 59 accounts, 41.183 of them created inside
 * thirty days. Nobody registered that; it is the panorama seed. So the banner
 * stays wherever a figure, a record or a credential is on screen, and turning
 * it off globally was refused: a site that presents fabricated population
 * numbers as real, to a Play reviewer and to national officials, is a worse
 * problem than the one the banner creates.
 *
 * On a page of pure legal text there is no datum for the sentence to be about.
 * "The data you are looking at is synthetic" printed above a privacy policy is
 * not a more honest page — it is a claim with no referent, and it costs
 * something real: `/privacidad` is the URL Google Play has on file as this
 * app's privacy policy and account-deletion pathway, so a reviewer opens it
 * and reads a banner saying the product is a demonstration. That is a rejection
 * risk bought with zero honesty gained.
 *
 * WHAT IS DELIBERATELY NOT HERE, and each of these was considered:
 *
 *   · `/` — the landing shows the flagship credential and its QR, which is a
 *     SEEDED pet. Data on screen; banner stays.
 *   · `/transparencia` and its dataset downloads — every figure there is
 *     computed from the seeded population. This is the page where the
 *     disclosure matters MOST, and it would be the easiest one to exempt by
 *     mistake because it reads like a documentation page.
 *   · The sign-up and sign-in pages — no records are displayed, but an account
 *     created there is real and lands in this environment. The banner is the
 *     only thing telling that person what they are joining. "Shows no data" is
 *     not the same test as "changes nothing"; this list is the first, and only
 *     the first.
 *   · Every operator surface (/gob, /admin, /org) and every citizen surface —
 *     records, all of them.
 *
 * An allowlist and not a blocklist, because the failure directions are not
 * symmetric: forgetting to add a page here leaves a harmless banner on a legal
 * page, while forgetting to REMOVE a page from a blocklist silently strips the
 * disclosure off a screen full of fabricated records.
 */
const DATA_FREE_PATHS: ReadonlySet<string> = new Set([
  "/privacidad",
  "/terminos",
  "/cookies",
  "/accesibilidad",
  "/leyes",
  "/acerca",
  "/ayuda",
  "/sugerencias",
]);

/**
 * Whether the demo disclosure has anything to disclose on this path.
 *
 * Exact match, never a prefix. `/leyes` is static text; a hypothetical
 * `/leyes/[jurisdiccion]` that resolved a real rule set would be data, and a
 * `startsWith` check would have exempted it the day it shipped without anybody
 * deciding to. A new page earns its exemption by being named.
 *
 * A trailing slash is normalised because Next will serve both spellings and a
 * disclosure that depends on which one the visitor typed is not a rule.
 */
export function demoBannerAppliesTo(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return !DATA_FREE_PATHS.has(normalized);
}
