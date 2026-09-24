// Single source of truth for the magic-link / OTP TTL.
//
// IMPORTANT: This value MUST stay in sync with `supabase/config.toml`
// [auth.email] otp_expiry (currently 3600 s) and any production Supabase
// auth override.  When you change one, change the other.
//
// The panel is a client component so it cannot read a server-only env var at
// render time. We use an env override here for server-side contexts (e.g.
// scripts, emails), but the component simply imports MAGIC_LINK_TTL_SECONDS
// as a compile-time constant. Keep the two values aligned.

export const MAGIC_LINK_TTL_SECONDS: number = process.env.MAGIC_LINK_TTL_SECONDS
  ? Number(process.env.MAGIC_LINK_TTL_SECONDS)
  : 3600;

/**
 * Format a TTL in seconds into an es-AR human-readable string.
 *
 * Examples:
 *   3600  → "1 hora"
 *   7200  → "2 horas"
 *   1800  → "30 minutos"
 *   86400 → "24 horas"
 */
export function formatTtl(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hora" : `${hours} horas`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minutos`;
}
