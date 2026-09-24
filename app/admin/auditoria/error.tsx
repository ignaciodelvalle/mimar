"use client";

// Segment error boundary for /admin/auditoria (platform-budget T3.3, same
// rationale as app/admin/panorama/error.tsx): the page now streams its body
// behind Suspense — a throw inside the streamed body must resolve into an
// honest, recoverable "reintentar" state at THIS segment, never a perpetual
// skeleton.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function AdminAuditoriaError({
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
