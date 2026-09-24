"use client";

// Shared error-boundary surface used by every route-group error.tsx in the
// app (sprint 6 PR-051). Next.js calls the route-level error.tsx with two
// props — error + reset — and this component renders a friendly fallback
// with two actions: Reintentar (invokes reset()) and Volver al inicio.
//
// Privacy posture: we render the error.message in non-production to help
// debugging. In production we surface a stable digest (Next.js's hashed
// error reference) so support can match it against server logs without
// leaking stack traces.

import Link from "next/link";
import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";
import { LnButton } from "@/components/ui/Button";
import { reportError } from "@/lib/observability/report-error";

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref?: string;
  homeLabel?: string;
};

// PO quick win B4 (2026-07-24): "sin código" fallback — an operator/citizen
// reading this over the phone to support needs a stable string either way,
// never a blank line.
const NO_CODE_LABEL = "sin código";

export function ErrorBoundary({
  error,
  reset,
  homeHref = "/",
  homeLabel = "Volver al inicio",
}: Props) {
  // Report the error through the shared observability seam. The server side
  // already logged it as part of the boundary trip — this is purely for
  // in-tab debugging until a real sink is wired (see lib/observability/report-error.ts).
  useEffect(() => {
    reportError(error, { route: "ErrorBoundary", homeHref });
  }, [error, homeHref]);

  const isProd = process.env.NODE_ENV === "production";
  const code = error.digest ?? NO_CODE_LABEL;
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (permissions/older browser) — the code is
      // already visible on-screen for a manual copy, so this is a silent no-op.
    }
  };

  return (
    // TYPOGRAPHY IS DECLARED, NOT INHERITED (QA 2026-08-07).
    //
    // This screen used to take whatever families its ancestor happened to set,
    // and rendered its body in Encode Sans — the SITE CHROME face, not the
    // product's IBM Plex Sans — because an error can bubble past the layout
    // that would have set the portal font. It also used Tailwind's bare
    // `font-mono`, i.e. the system `ui-monospace` stack, for the error code,
    // while every other code in the product (DIM-, CAS-, DEN-) is IBM Plex
    // Mono.
    //
    // That is exactly backwards: this is the moment the user most needs to feel
    // they are still inside the same product. Both families are stated
    // explicitly here, and they hold in BOTH skins — the citizen and operator
    // tiers both sit on Plex (globals.css `--font-ln-sans` / `--font-ln-mono`).
    <main className="font-ln-sans min-h-screen flex items-center justify-center p-6 bg-[var(--color-ln-card)]">
      <div className="max-w-md w-full text-center space-y-4">
        <div
          className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-ln-warn)]/15 text-[var(--color-ln-warn)]"
          aria-hidden="true"
        >
          <Icon name="alerta" size={28} decorative />
        </div>
        <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">Algo salió mal</h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Probá de nuevo o volvé al inicio. Si el problema persiste, este es el código que el equipo
          necesita ver:
        </p>
        <div className="flex items-center justify-center gap-2">
          <p className="font-ln-mono text-xs text-[var(--color-ln-mute)] break-all">
            Código de error: {code}
          </p>
          <LnButton variant="ghost" size="sm" onClick={copyCode} className="shrink-0 text-xs">
            {copied ? "Copiado" : "Copiar código"}
          </LnButton>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <LnButton variant="primary" onClick={reset} className="flex-1">
            Reintentar
          </LnButton>
          <Link href={homeHref} className="flex-1">
            {/* secondary → ghost: outline card-bg button — same semantic intent */}
            <LnButton variant="ghost" className="w-full">
              {homeLabel}
            </LnButton>
          </Link>
        </div>
        {!isProd && (
          <details className="text-left text-xs text-[var(--color-ln-mute)] mt-4 pt-4 border-t border-[var(--color-ln-line)]">
            <summary className="cursor-pointer font-medium">Stack trace (solo dev)</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-ln-mono text-xs">
              {error.message}
              {"\n\n"}
              {error.stack ?? "(sin stack)"}
            </pre>
          </details>
        )}
      </div>
    </main>
  );
}
