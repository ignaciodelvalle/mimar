"use client";

// ObservationCloseInspector — inline slide-over hosting the professional
// close form on the /admin/observaciones LIST (inline-close convergence
// 2026-08-02: two screens for one action become one — the list row's
// "Cerrar profesionalmente" used to be a full navigation to the
// [publicToken] detail page whose only job was a single form; the form now
// opens in place, and the detail route stays as the deep-link/modifier-click
// fallback).
//
// Pattern: the master-detail inspector proven in app/gob/maltrato/_inspector/
// — the a11y shell (InspectorPanel: focus-to-close-button, Esc, full-page
// escape hatch) is IMPORTED from there, not re-expressed; selection lives in
// `?cerrar=<publicToken>` written via native History
// (observation-inspector-nav.ts), so the list Server Component never re-runs.
//
// Data: NO fetch. Every field this panel shows (pet name, species,
// jurisdiction, owner, inicio/cierre estimado) is already rendered on the
// list card the operator just clicked — the server page passes those same
// values down, plus the per-row BOUND server action
// (professionalCloseRabiesObservationAction.bind(null, token)). No new PII
// crosses to the browser, and no audit gating is bypassed: the action
// re-validates role + jurisdiction scope server-side
// (professionalCloseObservation's govt scope check), exactly as it does for
// the detail page. The detail page's extra content (escalating-symptom
// history) deliberately stays OFF this panel — it belongs to the full page.
//
// Simpler than the maltrato mounter on purpose: one param, no sub-view
// drill, fixed overlay at every width (this list has no persistent right
// column to fill).

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

import { InspectorPanel } from "@/app/gob/maltrato/_inspector/InspectorPanel";
import type { ProfessionalCloseResult } from "@/src/modules/surveillance/actions";

import { CloseObservationForm } from "../[publicToken]/CloseObservationForm";
import { closeObservationInspector, syncDepthAfterPop } from "./observation-inspector-nav";

export type ObservationCloseRow = {
  publicToken: string;
  petName: string;
  /** Pre-localized on the server (speciesLabel) — keeps one label opinion. */
  speciesLabel: string;
  locality: string | null;
  province: string | null;
  ownerName: string | null;
  /** Pre-formatted on the server — same strings the list card renders. */
  startedLabel: string;
  deadlineLabel: string | null;
  /** professionalCloseRabiesObservationAction bound to this row's token. */
  closeAction: (formData: FormData) => Promise<ProfessionalCloseResult>;
};

export function ObservationCloseInspector({ rows }: { rows: ObservationCloseRow[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const token = searchParams.get("cerrar");

  // Keep the depth counter honest across browser-driven Back/Forward.
  useEffect(() => {
    function onPop() {
      syncDepthAfterPop(new URLSearchParams(window.location.search).has("cerrar"));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // URL with `cerrar` stripped — the state a close returns to.
  const cleanListUrl = useCallback((): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("cerrar");
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [pathname, searchParams]);

  const handleClose = useCallback(() => {
    const rowToken = token;
    closeObservationInspector(cleanListUrl());
    if (!rowToken) return;
    // The list node was never unmounted (shallow routing) — the trigger
    // anchor is still in the DOM. Restore focus after the close settles.
    window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-observacion-row="${rowToken}"]`)?.focus();
    }, 0);
  }, [token, cleanListUrl]);

  // No selection → nothing rendered (overlay-only inspector; the list owns
  // the viewport until a row's close action is invoked).
  if (!token) return null;

  const row = rows.find((r) => r.publicToken === token) ?? null;

  return (
    <div className="fixed inset-0 z-40 flex bg-black/30">
      {/* Dim area (non-interactive) — the ✕ button and Esc close the overlay,
          matching the maltrato inspector's mobile shape. */}
      <div aria-hidden="true" className="flex-1" />
      <div className="ml-auto flex h-full w-full max-w-md flex-col">
        <InspectorPanel
          title={row ? `Cierre profesional — ${row.petName}` : "Observación"}
          fullPageHref={`/admin/observaciones/${token}`}
          onClose={handleClose}
        >
          {row ? (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-ln-op-mute">Especie</dt>
                  <dd className="text-md text-ln-op-ink">{row.speciesLabel}</dd>
                </div>
                <div>
                  <dt className="text-sm text-ln-op-mute">{"Jurisdicción"}</dt>
                  <dd className="text-md text-ln-op-ink">
                    {row.locality ?? "—"}, {row.province ?? "—"}
                  </dd>
                </div>
                {row.ownerName && (
                  <div>
                    <dt className="text-sm text-ln-op-mute">{"Dueño/a"}</dt>
                    <dd className="text-md text-ln-op-ink">{row.ownerName}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-sm text-ln-op-mute">{"Observación"}</dt>
                  <dd className="text-md text-ln-op-ink">
                    {"Inicio: "}
                    {row.startedLabel}
                    {row.deadlineLabel ? ` · Cierre estimado: ${row.deadlineLabel}` : null}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-sm text-ln-op-mute">{"Token público"}</dt>
                  <dd className="font-ln-mono text-sm text-ln-op-mute">{row.publicToken}</dd>
                </div>
              </dl>
              <CloseObservationForm action={row.closeAction} />
            </div>
          ) : (
            // Selected token isn't among the in-progress rows on this page
            // (stale link, already-closed observation, or a filtered view) —
            // the detail route is the honest fallback, not a guess.
            <p className="py-6 text-center text-sm text-ln-op-mute">
              {"Esta observación no está en curso en la vista actual. "}
              <a
                href={`/admin/observaciones/${token}`}
                className="text-ln-op-azul underline underline-offset-2"
              >
                Abrir la página completa
              </a>
            </p>
          )}
        </InspectorPanel>
      </div>
    </div>
  );
}
