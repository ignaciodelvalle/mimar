"use client";

// NotificationQuickReply — inline quick-reply island for actionable owner
// notifications (capture-console surface #4).
//
// The owner types a short phrase describing what they did ("se la di hoy"),
// the SHARED matcher (lib/events/event-capture-matcher.ts — same one CaptureBox
// and AtenderQuickCapture use) parses it, and a CaptureConfidenceCard preview
// shows the resolved event + fields + confidence BEFORE anything is
// committed. The owner must explicitly tap "Confirmar" — there is no
// Enter-to-submit path from the textarea straight to a commit; Enter here
// only re-runs the matcher (the "Identificar" step), never a write.
//
// "Confirmar" and "Editar en el formulario" both navigate to the matched
// form (buildQuickReplyUrl — lib/ui/notification-quick-reply-nav.ts); only
// "Confirmar" appends `autoconfirm=1`. The target form owns the actual
// commit: it reuses its own useActionState/action wiring and only
// auto-submits when its native required-field validation passes (see
// VaccinationForm / CheckinForm's autoConfirm effect) — this component never
// calls a write action directly.

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { LnButton } from "@/components/ui/Button";
import { CaptureConfidenceCard } from "@/components/ui/CaptureConfidenceCard";
import { type MatchResult, matchCaptureIntent } from "@/lib/events/event-capture-matcher";
import { goToCaptureUrl } from "@/lib/ui/capture-nav";
import { buildQuickReplyUrl } from "@/lib/ui/notification-quick-reply-nav";
import { eventTypeLabel } from "@/lib/utils/format";

// The mount gate + allowlist moved to notification-quick-reply-eligibility.ts (a
// plain module) so the SERVER NotificationCard can call isQuickReplyEligible
// without crossing this "use client" boundary (staging 500, digest 1823265464).

const SLOT_LABELS: Record<string, string> = {
  vaccineName: "Vacuna",
  occurredAt: "Fecha",
  notes: "Notas",
  text: "Nota",
  kg: "Peso (kg)",
};

export function NotificationQuickReply({
  petPublicToken,
  reminderId,
}: {
  petPublicToken: string;
  reminderId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState("");
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [unmatched, setUnmatched] = useState(false);

  function identify(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    const result = matchCaptureIntent(trimmed);
    if (!result) {
      setMatch(null);
      setUnmatched(true);
      return;
    }
    setUnmatched(false);
    setMatch(result);
  }

  function navigate(autoconfirm: boolean) {
    if (!match) return;
    const url = buildQuickReplyUrl(petPublicToken, match, reminderId, autoconfirm);
    if (!url) return;
    goToCaptureUrl(pathname, url, router);
  }

  const fields = match
    ? Object.entries(match.slots).map(([key, value]) => ({
        label: SLOT_LABELS[key] ?? key,
        value,
      }))
    : [];

  return (
    <div className="space-y-2 pt-1">
      <form onSubmit={identify} className="space-y-2">
        <label htmlFor="notification-quick-reply-text" className="sr-only">
          Respuesta rápida
        </label>
        <textarea
          id="notification-quick-reply-text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (unmatched) setUnmatched(false);
          }}
          rows={2}
          placeholder='ej: "le di la antirrábica hoy"'
          className="w-full px-3 py-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink)] text-sm outline-none focus:border-[var(--color-ln-azul)]"
        />
        <LnButton type="submit" variant="ok" size="sm" disabled={!text.trim()}>
          Identificar →
        </LnButton>
      </form>

      {unmatched && (
        <p className="text-xs text-[var(--color-ln-warn)]">
          No reconocimos eso. Probá con otras palabras o usá el botón de arriba para ir al
          formulario completo.
        </p>
      )}

      {match && (
        <CaptureConfidenceCard
          eventTypeLabel={eventTypeLabel(match.eventType)}
          fields={fields}
          confidence={match.confidence}
          onConfirm={() => navigate(true)}
          onEdit={() => navigate(false)}
          confirmLabel={`Asentar ${eventTypeLabel(match.eventType).toLocaleLowerCase("es-AR")}`}
        />
      )}
    </div>
  );
}
