"use client";

// LnOfflineBanner — informational offline-state banner for the citizen shell
// (Track B — sistema de estados, B2; dim-interno:docs/reviews/results/2026-07-21-nivel-siguiente-plan.md).
//
// Structural precedent: components/ui/DemoModeBanner.tsx's <output> banner —
// same shape (full-width, above the rest of the chrome), different copy/tone/
// skin. A thin wrapper around useOnline(): renders nothing while online, the
// offline notice otherwise. Informational, not destructive — role="status" /
// aria-live="polite", never role="alert".

import { useOnline } from "@/lib/hooks/useOnline";

interface LnOfflineBannerProps {
  className?: string;
}

export function LnOfflineBanner({ className }: LnOfflineBannerProps = {}) {
  const online = useOnline();
  if (online) return null;

  return (
    // <output>'s implicit ARIA role is already "status" — an explicit
    // role="status" attribute is redundant (biome lint/a11y/noRedundantRoles)
    // and matches components/ui/DemoModeBanner.tsx's own banner exactly.
    <output
      aria-live="polite"
      className={[
        "block w-full border-b px-4 py-1.5 text-center",
        "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)]",
        "text-sm text-[var(--color-ln-ink-2)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      Sin conexión — revisá tu internet. Los cambios no se van a guardar hasta que vuelva la
      conexión.
    </output>
  );
}
