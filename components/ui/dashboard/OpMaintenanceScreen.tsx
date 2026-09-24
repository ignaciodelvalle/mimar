// OpMaintenanceScreen — full-page "under maintenance" state for the operator
// shells (/gob, /admin, /org — Track B, sistema de estados, B2).
//
// Rendered BEFORE any auth/data fetch in each operator layout, so it is
// intentionally NOT wrapped in AppShell — no rail/topbar data exists yet.
//
// Structural precedent: app/org/[orgToken]/admin/layout.tsx's restricted-
// access card (centered <main>, max-w-md card, h1 + body) — same full-page-
// card idea, operator tone, no action link (there is nothing to navigate to
// during a maintenance window). Passive informational state — the card
// wrapper is an <output> (implicit ARIA role "status"), not "alert": biome's
// lint/a11y/useSemanticElements rejects an explicit role="status" on ANY
// element (main or div) in favor of the semantic <output> tag itself.

import { Icon } from "@/components/Icon";

interface OpMaintenanceScreenProps {
  className?: string;
}

export function OpMaintenanceScreen({ className }: OpMaintenanceScreenProps = {}) {
  return (
    <main
      className={[
        "flex min-h-screen items-center justify-center p-6 bg-[var(--color-ln-op-page)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <output className="block max-w-md w-full text-center space-y-4">
        <div
          className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-ln-op-warn-bg)] text-[var(--color-ln-op-warn)]"
          aria-hidden="true"
        >
          <Icon name="reparacion" size={28} decorative />
        </div>
        <h1 className="text-title font-semibold text-[var(--color-ln-op-ink)]">En mantenimiento</h1>
        <p className="text-md text-[var(--color-ln-op-mute)]">
          Volvé en unos minutos. Estamos actualizando miMAR; tu información está segura.
        </p>
      </output>
    </main>
  );
}
