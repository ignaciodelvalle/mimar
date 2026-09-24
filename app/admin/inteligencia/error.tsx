"use client";

// Segment error boundary for /admin/inteligencia (platform-budget T3.2, same
// rationale as app/admin/panorama/error.tsx): the page now streams three
// budgeted panels behind Suspense — a throw inside a streamed panel must land
// on an honest, recoverable "reintentar" state at THIS segment instead of a
// perpetual skeleton or the route-group boundary.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function AdminInteligenciaError({
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
