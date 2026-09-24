"use client";

// Segment error boundary for the admin portal (error-path audit 2026-07-04
// E1): without it a throw anywhere under /admin/* bubbled to app/error.tsx —
// a fullscreen citizen-styled page with no OpShell rail and a home link to /,
// which is how the /admin/sistema digest crash disoriented QA. With this
// boundary the admin layout persists and the escape leads back to the panel.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function AdminPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundary
      error={error}
      reset={reset}
      homeHref="/admin"
      homeLabel="Volver al panel admin"
    />
  );
}
