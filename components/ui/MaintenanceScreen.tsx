// LnMaintenanceScreen — full-page "under maintenance" state for the citizen
// shell (Track B — sistema de estados, B2;
// dim-interno:docs/reviews/results/2026-07-21-nivel-siguiente-plan.md).
//
// Rendered BEFORE any auth/nav-data fetch in app/(app)/layout.tsx, so it is
// intentionally NOT wrapped in AppShell — no rail/topbar/masthead data exists
// yet at that point in the render.
//
// Structural precedent: components/ErrorBoundary.tsx's centered <main> card
// (icon circle + h1 + body copy) — but there is nothing to retry here, so no
// action button. Passive informational state — the card wrapper is an
// <output> (implicit ARIA role "status"), not "alert": biome's
// lint/a11y/useSemanticElements rejects an explicit role="status" on ANY
// element (main or div) in favor of the semantic <output> tag itself.

import { Icon } from "@/components/Icon";

interface LnMaintenanceScreenProps {
  className?: string;
}

export function LnMaintenanceScreen({ className }: LnMaintenanceScreenProps = {}) {
  return (
    <main
      className={[
        "flex min-h-screen items-center justify-center p-6 bg-[var(--color-ln-card)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <output className="block max-w-md w-full text-center space-y-4">
        <div
          className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-ln-warn)]/15 text-[var(--color-ln-warn)]"
          aria-hidden="true"
        >
          <Icon name="reparacion" size={28} decorative />
        </div>
        <h1 className="text-2xl font-semibold text-[var(--color-ln-ink)]">En mantenimiento</h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Volvé en unos minutos. Estamos actualizando miMAR; tu información está segura.
        </p>
      </output>
    </main>
  );
}
