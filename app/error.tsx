"use client";

// Root error boundary — caught by Next.js when any nested route segment
// throws and no segment-level error.tsx handles it first.
// Sprint 6 PR-051.

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorBoundary error={error} reset={reset} />;
}
