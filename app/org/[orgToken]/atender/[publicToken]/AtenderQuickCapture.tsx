"use client";

// Quick-entry textarea — atender console (#5). Mirrors the owner-flow
// CaptureBox pattern (app/(app)/mis-mascotas/[publicToken]/anotar/CaptureBox.tsx):
// the vet types a natural sentence, the SHARED matcher
// (lib/events/event-capture-matcher.ts) resolves it, and a
// CaptureConfidenceCard preview asks for confirmation before navigating into
// the matched clinical form. Narrowed to atender's 5 signable event types via
// ./atender-quick-capture-match (a raw match outside that vocabulary reads as
// unmatched, same as no match at all).
//
// On confirm, navigates to `?evento=X` with the matcher's extracted slots
// appended as query params — AtenderCaptureMounter reads them as prefill
// (vaccineName, occurredAt, text…), the same mechanism VaccinationForm's
// existing `initialVaccineName` prop already uses for a single field.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CaptureConfidenceCard } from "@/components/ui/CaptureConfidenceCard";
import { OpButton } from "@/components/ui/dashboard";
import { matchCaptureIntent } from "@/lib/events/event-capture-matcher";

import { ATENDER_EVENTOS } from "./atender-eventos";
import { type AtenderCaptureMatch, toAtenderCaptureMatch } from "./atender-quick-capture-match";

const SLOT_LABELS: Record<string, string> = {
  vaccineName: "Vacuna",
  occurredAt: "Fecha",
  text: "Nota",
};

function eventoLabel(evento: string): string {
  return ATENDER_EVENTOS.find((e) => e.key === evento)?.label ?? evento;
}

export function AtenderQuickCapture({
  orgToken,
  publicToken,
}: {
  orgToken: string;
  publicToken: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [match, setMatch] = useState<AtenderCaptureMatch | null>(null);
  const [unmatched, setUnmatched] = useState(false);

  function identify(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    const captured = toAtenderCaptureMatch(matchCaptureIntent(trimmed));
    if (!captured) {
      setMatch(null);
      setUnmatched(true);
      return;
    }
    setUnmatched(false);
    setMatch(captured);
  }

  function confirm() {
    if (!match) return;
    const params = new URLSearchParams({ evento: match.evento });
    for (const [key, value] of Object.entries(match.slots)) {
      if (value) params.set(key, value);
    }
    router.push(`/org/${orgToken}/atender/${publicToken}?${params.toString()}`);
  }

  function editInstead() {
    // "No es esto" — dismiss the preview so the vet can rephrase or use the
    // ¿Qué querés registrar? grid below directly. No navigation.
    setMatch(null);
  }

  const fields = match
    ? Object.entries(match.slots).map(([key, value]) => ({
        label: SLOT_LABELS[key] ?? key,
        value,
      }))
    : [];

  return (
    <div className="space-y-3">
      <form onSubmit={identify} className="space-y-2">
        <label htmlFor="atender-quick-capture" className="sr-only">
          ¿Qué le hiciste a la mascota?
        </label>
        <textarea
          id="atender-quick-capture"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (unmatched) setUnmatched(false);
          }}
          rows={2}
          placeholder='ej: "le di la antirrábica hoy"'
          className="w-full px-4 py-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] text-base outline-none focus:border-[var(--color-ln-azul)]"
        />
        {/* Azul, not ok/green (one-primary-per-screen review, 2026-08-06):
            parsing free text is the flow's PRIMARY step, not a success
            confirmation. Green stays for the affirmative half of a
            confirm/decline pair (Aceptar / Aprobar / Confirmar). */}
        <OpButton type="submit" variant="primary" disabled={!text.trim()}>
          Identificar →
        </OpButton>
      </form>

      {unmatched && (
        <p className="text-sm text-[var(--color-ln-warn)]">No reconocido, elegí un tipo abajo.</p>
      )}

      {match && (
        <CaptureConfidenceCard
          eventTypeLabel={eventoLabel(match.evento)}
          fields={fields}
          confidence={match.confidence}
          onConfirm={confirm}
          onEdit={editInstead}
          confirmLabel={`Asentar ${eventoLabel(match.evento).toLocaleLowerCase("es-AR")}`}
        />
      )}
    </div>
  );
}
