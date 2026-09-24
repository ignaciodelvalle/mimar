"use client";

// Segment error boundary for /admin/panorama (RESILIENCE 2026-07-10, PO
// instrumented-review finding #1). Without it, a throw inside the streamed
// panorama board (the Suspense child in page.tsx) bubbled to the route-group
// app/admin/error.tsx — and, worse, while the board was still streaming the
// operator was left staring at the parent "Cargando…" skeleton FOREVER (the
// server render never resolved into either a board or an error). A panorama-
// local boundary turns that into an honest, recoverable "algo salió mal ·
// reintentar" state so a rabies-surveillance operator is never stranded.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function AdminPanoramaError({
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
