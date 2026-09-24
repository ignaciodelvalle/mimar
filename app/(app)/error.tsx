"use client";

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function OwnerPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <ErrorBoundary error={error} reset={reset} homeHref="/inicio" homeLabel="Volver a Inicio" />
  );
}
