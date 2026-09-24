"use client";

// ScopeDisclosure — the panorama's "alcance" segment: the pill that says WHOSE
// data is on screen, and the only entry point to the province → locality drill.
//
// WHY ITS OWN FILE: it moved out of PanoramaConsole's top-left floating cluster
// into the sticky ContextBar (2026-08-01), and PanoramaConsole is over the
// file-size ratchet's budget — the fence's standing instruction is to EXTRACT,
// never to feed it. The extraction is a MOVE: same OverlayDisclosure, same
// testid, same copy, same closed-by-default panel (PO decision 2026-07-29).
// Nothing here was rewritten, which is why the console's scope tests keep
// passing untouched.
//
// TWO INVARIANTS THIS FILE CARRIES:
//
//  1. The panel starts CLOSED and the pill is therefore the ENTIRE affordance —
//     see ScopePillSummary.tsx, which documents why the verb is visible text and
//     not an sr-only label.
//
//  2. It is CONTROLLED by the console's single open-panel state, so the scope
//     panel, a ContextBar segment and a rail panel can never be open at once.

import {
  type JurisdictionScope,
  JurisdictionSwitcher,
} from "@/components/gob/JurisdictionSwitcher";
import { OverlayDisclosure } from "@/components/panorama/OverlayDisclosure";
import { ScopePillSummary } from "@/components/panorama/ScopePillSummary";
import type { ReactNode } from "react";

type Props = {
  /**
   * The resolved scope label — `resolveScopeLabel`'s output (scope-truth.ts),
   * the SAME string the Registros caption, the dock meta, the PNG footer and the
   * printed informe cite. Never a locally re-derived cascade.
   */
  scopeLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Close the panel when the committed scope changes (restores focus). */
  closeSignal: unknown;
  allowedProvinces: Array<{ code: string; name: string }> | undefined;
  localities: Array<{ slug: string; name: string }>;
  selectedProvince: string | null;
  selectedLocality: string | null;
  onScopeCommit: (scope: JurisdictionScope) => void;
  /** Extra scope-adjacent filters the page injects. */
  filtersSlot?: ReactNode;
};

export function ScopeDisclosure({
  scopeLabel,
  open,
  onOpenChange,
  closeSignal,
  allowedProvinces,
  localities,
  selectedProvince,
  selectedLocality,
  onScopeCommit,
  filtersSlot,
}: Props) {
  return (
    <div className="flex-shrink-0">
      <OverlayDisclosure
        summaryTestId="panorama-scope-pill"
        panelId="panorama-scope-panel"
        open={open}
        onOpenChange={onOpenChange}
        panelClassName="left-0 w-[22rem] max-w-[calc(100vw-1.5rem)]"
        closeSignal={closeSignal}
        summaryClassName="inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border border-ln-op-azul bg-ln-op-card px-3.5 py-1 text-sm font-semibold text-ln-op-azul hover:bg-ln-op-azul/10"
        summary={<ScopePillSummary scopeLabel={scopeLabel} />}
      >
        <div className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            Jurisdicción
          </p>
          {/* The JurisdictionSwitcher is rendered CLIENT-SIDE (embedded drill): a
              province/locality pick commits the scope shallowly (no reload).
              Native selects = the full keyboard path. */}
          {allowedProvinces !== undefined && (
            <JurisdictionSwitcher
              allowedProvinces={allowedProvinces}
              localities={localities}
              selectedProvince={selectedProvince}
              selectedLocality={selectedLocality}
              onScopeCommit={onScopeCommit}
            />
          )}
          {filtersSlot}
          <p className="text-xs leading-snug text-ln-op-faint">
            También podés hacer clic en una provincia del mapa.
          </p>
        </div>
      </OverlayDisclosure>
    </div>
  );
}
