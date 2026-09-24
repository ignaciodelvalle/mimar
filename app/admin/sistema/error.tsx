"use client";

// Segment error boundary for /admin/sistema (platform-budget T3.1, same
// rationale as app/admin/panorama/error.tsx): with the page now streaming its
// sections behind Suspense, a throw inside a streamed section must resolve
// into an honest, recoverable "reintentar" state at THIS segment — never a
// perpetual skeleton, and never the route-group boundary swallowing the rail.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function AdminSistemaError({
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
