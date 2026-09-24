"use client";

// AtenderVaccinationGate — THE HARD GATE (PO decision, #5), atender-only.
//
// Wraps the SHARED owner VaccinationForm UNMODIFIED — its own free-text
// behavior (any typed name submits as-is) stays exactly as it is for the
// owner flow. This wrapper intercepts the form's `action` before the
// atender writer ever sees an unmatched/uncatalogued vaccine name:
//
//   - confidence >= VACCINE_AUTOSELECT_CONFIDENCE (single top candidate,
//     guaranteed by matchVaccineFreeText's tie rule) → canonicalize silently
//     and submit.
//   - otherwise → BLOCK the submit, show the top-3 candidates + an explicit
//     "no está en el catálogo — continuar igual" escape hatch.
//   - "continuar igual" → the NEXT submit (same typed text) flags the notes
//     field ("vacuna no catalogada: <name>") and proceeds — never silently
//     accepted as ordinary free text, never migrated into the catalog.
//
// atenderVaccinationAction mirrors this server-side (defense in depth).

import { useState } from "react";

import { VaccinationForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/vacuna/VaccinationForm";
import type { EventFormState } from "@/src/modules/events/actions";

import type { VaccineMatchCandidate } from "@/lib/reference/vaccine-fuzzy-match";
import {
  resolveVaccineGate,
  speciesForVaccineMatch,
  withUncataloguedVaccineFlag,
} from "../atender-vaccine-gate";

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

type ReviewState = { candidates: VaccineMatchCandidate[]; typedName: string };

export function AtenderVaccinationGate({
  action,
  species,
  initialVaccineName,
  signedContext,
}: {
  action: FormAction;
  species: string;
  initialVaccineName?: string;
  /** Forwarded to VaccinationForm — true only for a matrícula-verified
   * signer, whose events land verified and must not show the owner-facing
   * "dato declarado" callout. */
  signedContext?: boolean;
}) {
  const [review, setReview] = useState<ReviewState | null>(null);
  // VaccinationForm's own vaccine field is uncontrolled by us — initialVaccineName
  // only seeds the FIRST render. Remounting via `key` is how a picked catalog
  // candidate pushes a new starting value into it.
  const [prefillName, setPrefillName] = useState(initialVaccineName ?? "");
  // The exact typed string the vet already approved as "no está en el
  // catálogo — continuar igual". Compared against the next submit's value so
  // editing the name re-triggers the gate instead of silently bypassing it.
  const [approvedUncatalogued, setApprovedUncatalogued] = useState<string | null>(null);

  const gatedAction: FormAction = async (prev, formData) => {
    const typed = String(formData.get("vaccineName") ?? "").trim();
    if (!typed) return action(prev, formData); // base action's own "missing" error fires

    const decision = resolveVaccineGate(typed, speciesForVaccineMatch(species));

    if (decision.kind === "autoselect") {
      formData.set("vaccineName", decision.canonicalName);
      setReview(null);
      return action(prev, formData);
    }

    if (approvedUncatalogued === typed) {
      const notes = String(formData.get("notes") ?? "");
      formData.set("notes", withUncataloguedVaccineFlag(notes, typed));
      setReview(null);
      return action(prev, formData);
    }

    setReview({ candidates: decision.candidates, typedName: typed });
    return { error: "Confirmá la vacuna en el listado de abajo antes de continuar." };
  };

  function pickCandidate(name: string) {
    setPrefillName(name);
    setReview(null);
  }

  function continueUncatalogued() {
    if (!review) return;
    setApprovedUncatalogued(review.typedName);
    setReview(null);
  }

  return (
    <>
      <VaccinationForm
        key={prefillName}
        action={gatedAction}
        species={species}
        initialVaccineName={prefillName}
        defaults={{ occurredAt: null, notes: null }}
        signedContext={signedContext}
      />
      {review && (
        <div className="mt-3 space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-card)] p-3">
          <p className="text-sm font-semibold text-[var(--color-ln-ink)]">
            &ldquo;{review.typedName}&rdquo; no se reconoce con certeza. Elegí una opción:
          </p>
          {review.candidates.length > 0 && (
            <ul className="space-y-1.5">
              {review.candidates.map((c) => (
                <li key={c.vaccine.name}>
                  <button
                    type="button"
                    onClick={() => pickCandidate(c.vaccine.name)}
                    className="w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
                  >
                    {c.vaccine.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={continueUncatalogued}
            className="w-full text-left px-3 py-2 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] text-sm text-[var(--color-ln-mute)] hover:bg-[var(--color-ln-stripe)]"
          >
            No está en el catálogo — continuar igual
          </button>
        </div>
      )}
    </>
  );
}
