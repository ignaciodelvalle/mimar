// Single canonical resolver for the app's public origin.
//
// Historically the codebase carried three divergent hardcoded fallbacks for
// NEXT_PUBLIC_SITE_URL — "https://mimar.ar", "https://mimar.gob.ar", and
// "https://www.mimar.gob.ar" — so an unset var produced a different domain
// depending on which page rendered it (credential QR vs adoption ficha vs org
// invite). This funnels every one of those call sites through ONE fallback.
//
// The empty-string case matters: `vercel env` can set a var to "" (not unset),
// and `?? "…"` does NOT catch that — it would leave a host-less relative URL
// that no phone camera can resolve (a real past QR bug on the landing hero).
// We read with `.trim()` and a truthiness fallback so a set-but-empty or
// whitespace-only value still lands on the canonical default. A trailing slash
// is stripped so callers can safely append `/p/{token}` etc.
//
// Canonical fallback = the brand domain we actually control. The production
// domain is still set explicitly via NEXT_PUBLIC_SITE_URL in Vercel (see
// dim-interno:docs/ops/production-deploy-plan.md "Site URL consistency") — this fallback is
// only ever exercised in local dev / preview where the var isn't set. That
// "only ever" is precisely why the value went unnoticed for so long, and why
// __tests__/public-hostname-fence.test.ts now reads it through resolveSiteUrl()
// rather than trusting the comment.
//
// NOT covered here (deliberately different semantics, left as-is):
//   - app/sitemap.ts — fails LOUD in production rather than guessing a domain
//     for search engines; a silent fallback there would be a regression.
//   - app/layout.tsx metadataBase — falls back to http://localhost:3000 on
//     purpose (never advertise a guessed production origin from that surface).
//
// components/pet-profile/LostCaseBlock.tsx used to be excluded here too (its
// own localhost fallback, "on purpose"), but that raw `?? "http://localhost:3000"`
// didn't catch a set-but-EMPTY NEXT_PUBLIC_SITE_URL and produced a relative,
// unclickable share link for a lost pet's main broadcast channel — the exact
// bug this module exists to prevent. It now calls credentialQrUrl() like the
// credential QR does (state-honesty re-audit, 2026-07-19). Flagged for PO: this
// changed LostCaseBlock's fallback domain from localhost to the canonical brand
// origin when NEXT_PUBLIC_SITE_URL is unset/empty — if a genuinely different
// fallback is wanted for local dev, that needs a product call, not a silent
// revert of this fix.
//
// THE PRODUCT CALL THAT 2026-07-19 ASKED FOR — MADE 2026-09-07
// ---------------------------------------------------------------------------
// The fallback that replaced localhost was `https://mimar.ar`, and that domain
// DOES NOT EXIST: 8.8.8.8 and 1.1.1.1 both answer `Non-existent domain`. That
// is NXDOMAIN, not an empty record set — the name is undelegated, so there is
// no NS and therefore no A to serve a page and no MX to take mail. It cannot
// be fixed with a DNS entry by anyone who does not first buy the name.
// So the mechanism above was right and its value was a dead letter:
// every credential QR rendered without NEXT_PUBLIC_SITE_URL encoded a host no
// phone could resolve, which is the same class of failure as the relative-URL
// bug it was introduced to cure. The PO will not register `mimar.ar` ("es el
// dominio que tenemos"), so the constant moves rather than the domain.
//
// The domain the project owns is `mimar.com.ar`. Its apex and its `www.` host
// both resolve (216.198.79.1 / 64.29.17.1, Vercel), and `www.mimar.com.ar` is
// the production origin of record — the alias of this same deployment
// (docs/architecture/system-context.md) and the API base the store build ships
// with (apps/mobile/src/release/release-config.test.ts asserts it). The
// fallback names that host so an unset var lands where the app actually is,
// instead of on a second origin only the web tier believes in.

/**
 * Registrable domains this project owns and can serve traffic from.
 *
 * This is the WEB counterpart of OWNED_MAIL_DOMAINS in lib/ui/contact.ts, and
 * deliberately a separate list: a domain needs an A/AAAA record to serve a
 * page and an MX record to receive mail, and those are different facts. The
 * two are related by containment, not by equality — you cannot receive mail at
 * a domain you do not own — and `__tests__/public-hostname-fence.test.ts`
 * asserts that containment so the lists cannot drift into disagreeing about
 * what "ours" means.
 *
 * ADD A DOMAIN HERE ONLY ONCE IT RESOLVES. This list is the fence's definition
 * of "a domain we own", so an aspirational entry does not widen it — it
 * disarms the check. `mimar.gob.ar`, the eventual government origin, is
 * absent until it is delegated; `mimar.ar` was removed on 2026-09-07 because
 * it never existed.
 */
export const OWNED_WEB_DOMAINS = ["mimar.com.ar"] as const;

/** The one domain the product is read aloud, printed, and typed as. */
export const CANONICAL_DOMAIN = OWNED_WEB_DOMAINS[0];

/**
 * The host the deployment actually answers on. The apex is aliased to it, so
 * naming `www.` here costs a visitor nothing and keeps this fallback identical
 * to the origin the store build already ships with — one origin, not two.
 */
const CANONICAL_SITE_URL = `https://www.${CANONICAL_DOMAIN}`;

/**
 * Resolves the app's public origin from NEXT_PUBLIC_SITE_URL, trimming
 * whitespace, dropping any trailing slash, and falling back to the single
 * canonical brand domain when the var is unset, empty, or whitespace-only.
 */
export function resolveSiteUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  return raw.replace(/\/+$/, "") || CANONICAL_SITE_URL;
}

/**
 * Absolute URL a credential QR encodes for a pet's public page.
 *
 * Always absolute: `resolveSiteUrl()` never returns an empty origin (the
 * set-but-empty NEXT_PUBLIC_SITE_URL case falls back to the canonical brand
 * domain), so the QR can never encode a host-less relative URL that a phone
 * camera cannot resolve — the real past landing-hero bug this module cures.
 */
export function credentialQrUrl(publicToken: string): string {
  return `${resolveSiteUrl()}/p/${publicToken}`;
}
