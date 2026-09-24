"use client";

// OpOfflineBanner — informational offline-state banner for the operator
// shells (/gob, /admin, /org — Track B, sistema de estados, B2).
//
// Same behavior as components/ui/OfflineBanner.tsx's LnOfflineBanner, Op-
// skinned with the --color-ln-op-warn-bg/-bd pair (the exact warn tint pair
// already exists for the operator tier, same family DemoModeBanner uses for
// its own Op-context banner — no new tokens invented).

import { useOnline } from "@/lib/hooks/useOnline";

interface OpOfflineBannerProps {
  className?: string;
}

export function OpOfflineBanner({ className }: OpOfflineBannerProps = {}) {
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
        "border-[var(--color-ln-op-warn-bd)] bg-[var(--color-ln-op-warn-bg)]",
        "text-sm text-[var(--color-ln-op-ink-2)]",
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
