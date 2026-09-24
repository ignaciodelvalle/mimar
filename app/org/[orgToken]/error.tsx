"use client";

import { useParams } from "next/navigation";

import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function OrgPortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams<{ orgToken: string }>();
  const orgToken = typeof params?.orgToken === "string" ? params.orgToken : "";
  return (
    <ErrorBoundary
      error={error}
      reset={reset}
      homeHref={orgToken ? `/org/${orgToken}` : "/"}
      homeLabel="Volver al panel de la organización"
    />
  );
}
