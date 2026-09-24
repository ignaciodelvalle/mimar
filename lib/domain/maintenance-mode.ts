// lib/domain/maintenance-mode.ts — server-safe maintenance-mode flag helper.
//
// Mirrors lib/domain/demo-mode.ts: a tiny pure function living OUTSIDE any
// "use client" module, taking the raw env string as a param so it stays
// testable without touching process.env and so every server layout (which
// must check this BEFORE any auth/data fetch) can import it directly.

/**
 * Returns true when the app-wide maintenance kill-switch is active.
 *
 * Only "1" or "true" enables maintenance mode — anything else (undefined,
 * "false", etc.) is off, matching the NEXT_PUBLIC_PUSH_ENABLED convention in
 * components/pwa/ServiceWorkerRegistrar.tsx.
 */
export function isMaintenanceMode(envValue: string | undefined): boolean {
  return envValue === "1" || envValue === "true";
}
