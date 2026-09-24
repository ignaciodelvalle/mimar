"use client";

// Segment error boundary for the public route group — the highest-traffic
// unauthenticated surface (landing, /adoptar, /perdidas, /refugios, public
// credentials). Without it a throw anywhere under (public)/* bubbled to the
// root app/error.tsx; this keeps the failure inside the group and points the
// escape back to the landing. Mirrors app/(app)/error.tsx and
// app/admin/error.tsx (launchworthy audit 2026-07-15, Domain 1 HIGH).

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} homeHref="/" homeLabel="Volver al inicio" />;
}
