"use client";

// GovtJurisdictionsChip — the topbar scope chip made expandable so a
// multi-locality operator can see WHICH jurisdictions they cover (Cowork M5).
//
// The static chip only showed the COUNT ("GOB · 5 LOCALIDADES") — an operator
// had to infer their localities from the Novedades feed. This wraps the chip in
// a button that toggles a "Tus jurisdicciones: …" list. Used only for govt with
// more than one locality; a single-locality govt already reads its locality in
// the label, and an admin has universal scope.

import { useState } from "react";

import type { AdminOrGovtJurisdiction } from "@/lib/infra/auth-guards";

import { OpScopeChip } from "@/components/ui/dashboard/OpScopeChip";

export function GovtJurisdictionsChip({
  label,
  jurisdictions,
}: {
  /** Secondary label already shown on the chip (e.g. "5 LOCALIDADES"). */
  label: string;
  jurisdictions: AdminOrGovtJurisdiction[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Ver tus ${jurisdictions.length} jurisdicciones`}
        className="inline-flex cursor-pointer items-center rounded-[var(--radius-sm)] border-0 bg-transparent p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul"
      >
        <OpScopeChip code="GOB" label={label} />
      </button>

      {open && (
        <>
          {/* Outside-click backdrop. */}
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default border-0 bg-transparent p-0"
            aria-label="Cerrar lista de jurisdicciones"
            onClick={() => setOpen(false)}
          />
          <div
            role="tooltip"
            className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-ln-op-line bg-ln-op-card p-3 shadow-lg"
          >
            <p className="mb-1.5 text-xs font-bold uppercase tracking-[0.1em] text-ln-op-mute">
              Tus jurisdicciones
            </p>
            <ul className="space-y-0.5 text-sm text-ln-op-ink">
              {jurisdictions.map((j) => (
                <li key={`${j.province}|${j.locality}`}>
                  {j.locality}, {j.province}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </span>
  );
}
