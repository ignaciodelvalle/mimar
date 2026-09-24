"use client";

// Segment error boundary for a single pet profile (error-path audit
// 2026-07-04 N5/E2): without it a throw while loading/rendering a pet's
// profile, events, or timeline bubbles up to app/(app)/error.tsx — which
// still recovers but sends the owner back to /inicio instead of the
// registry they were browsing. Escaping to /mis-mascotas keeps them one
// tap from every other pet instead of the dashboard.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function PetProfileError({
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
      homeHref="/mis-mascotas"
      homeLabel="Volver a Mis mascotas"
    />
  );
}
