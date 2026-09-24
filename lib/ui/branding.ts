/**
 * Single source of truth for miMAR branding.
 *
 * Reference these constants instead of hardcoding the name, so a rebrand is a
 * one-file change. This is intentionally build-time config, NOT a runtime
 * settings screen: miMAR is single-tenant with a fixed brand, so a DB-backed
 * admin setting would be over-engineering. Promote to a settings screen only
 * once there are several genuinely runtime-tunable values.
 *
 * THERE IS NO LOGO CONSTANT, and its absence is the point. `logoSrc:
 * "/logo-mimar.svg"` sat here pointing at a wordmark no component ever
 * rendered, so the "one-file change" it promised was false in the only way
 * that matters: a rebrand editing this line would have missed both places the
 * mark is actually drawn. The asset itself was deleted 2026-09-04 (dead file,
 * zero references). The mark is
 * `public/logo-mimar-mark.svg`, referenced
 * by path where it is used — the masthead brand slot
 * (components/layout/AppCitizenMasthead.tsx) and the launcher-icon build
 * (scripts/build-mobile-app-icons.ts) — which is two call sites a grep finds
 * and an unread constant is not.
 */
export const BRANDING = {
  /** Short wordmark. */
  appName: "miMAR",
  /** Full institutional name. */
  appNameLong: "Mi Mascota Argentina",
  /** One-line descriptor. */
  tagline: "Credencial digital sanitaria",
} as const;
