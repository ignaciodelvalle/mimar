/**
 * The public Google Play listing, or null while the app is not published.
 *
 * WHY AN ENV VAR. The Android app is not on Play yet. Any page that offers
 * "descargá la app" must say nothing about an app until the listing exists,
 * and must start saying it the day it does, with no code change. So the copy
 * is gated on NEXT_PUBLIC_PLAY_STORE_URL: unset (or not a Play URL) → null →
 * the caller renders no mention of an app at all.
 *
 * Only an https://play.google.com/ URL counts, so a placeholder or a typo in
 * the dashboard degrades to "no app" instead of a dead link on a public page.
 */
export function resolvePlayStoreUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.NEXT_PUBLIC_PLAY_STORE_URL ?? "").trim();
  if (raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "play.google.com" ? url.toString() : null;
  } catch {
    return null;
  }
}
