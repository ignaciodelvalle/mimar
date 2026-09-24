"use client";

import { useId } from "react";

import type { IconName } from "@/components/Icon";
import { LnBadge } from "@/components/ui/Badge";
import { LnButton } from "@/components/ui/Button";
import { LnCardBody } from "@/components/ui/Card";

/**
 * LnCaptureConfidenceCard — presentational confirm/edit card for the
 * captura-rápida pipeline.
 *
 * Shared foundation reused by: the atender console, the notification
 * quick-reply, and a future OCR pipeline. ZERO matching logic lives here —
 * the caller resolves free text to an eventType + fields + confidence
 * (e.g. via lib/reference/vaccine-fuzzy-match.ts or
 * lib/events/event-capture-matcher.ts) and this component only renders the
 * result and reports the two possible user decisions.
 *
 * Styled with LN tokens (no gob-* classes).
 *
 * Accessibility:
 *  - `<section aria-labelledby>` — a `<section>` with an accessible name is
 *    an implicit ARIA "region" landmark (an explicit `role="region"` here
 *    would be redundant per lint/a11y/noRedundantRoles), so the card is a
 *    real landmark, not just a styled `<div>`.
 *  - Confidence is rendered as TEXT via `LnBadge`, never color-only (WCAG) —
 *    the color+icon are a reinforcing cue, not the only signal.
 *  - `onConfirm` / `onEdit` are real `<button>`s (via `LnButton`) with their
 *    label as the accessible name.
 */

export type CaptureConfidenceLevel = "high" | "medium" | "low";

export type CaptureConfidenceField = {
  label: string;
  /** Already es-AR formatted by the caller (fecha, vacuna, etc.). */
  value: string;
};

export type CaptureConfidenceCardProps = {
  eventTypeLabel: string;
  fields: CaptureConfidenceField[];
  confidence: CaptureConfidenceLevel;
  onConfirm: () => void;
  /** "No es esto" → open the full form. */
  onEdit: () => void;
  /**
   * REQUIRED — the verb of the act the card is about to perform ("Asentar la
   * vacuna"), never the generic "Confirmar" (PO decision D.3, 2026-07-30; see
   * the grammar note in components/ui/ConfirmDialog.tsx). There is deliberately
   * no default: this card's whole job is to say "we read X — is that right?",
   * and a button labelled "Confirmar" answers a question the card never asked.
   */
  confirmLabel: string;
  editLabel?: string;
  className?: string;
};

const CONFIDENCE_TEXT: Record<CaptureConfidenceLevel, string> = {
  high: "Alta confianza",
  medium: "Confianza media",
  low: "Confianza baja",
};

const CONFIDENCE_BADGE_VARIANT: Record<CaptureConfidenceLevel, "success" | "warning" | "danger"> = {
  high: "success",
  medium: "warning",
  low: "danger",
};

const CONFIDENCE_ICON: Record<CaptureConfidenceLevel, IconName> = {
  high: "check-circle",
  medium: "warning",
  low: "error",
};

// Mirrors LnCard's frame (Card.tsx) rather than importing it directly: this
// component renders a `<section>` (implicit region landmark) as its root,
// which LnCard's fixed `<div>` output doesn't give us. LnCardBody IS reused
// below.
const cardFrame =
  "overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] " +
  "bg-[var(--color-ln-card)] shadow-[var(--shadow-sm)]";

export function CaptureConfidenceCard({
  eventTypeLabel,
  fields,
  confidence,
  onConfirm,
  onEdit,
  confirmLabel,
  editLabel = "Editar en el formulario",
  className = "",
}: CaptureConfidenceCardProps) {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className={[cardFrame, className].filter(Boolean).join(" ")}>
      {/* Header: event type + confidence badge */}
      <div className="flex items-center gap-2 border-b border-[var(--color-ln-line-2)] px-4 py-3">
        <h3
          id={titleId}
          className="m-0 min-w-0 flex-1 font-ln-serif text-base font-semibold leading-tight text-[var(--color-ln-ink)]"
        >
          {eventTypeLabel}
        </h3>
        <LnBadge variant={CONFIDENCE_BADGE_VARIANT[confidence]} icon={CONFIDENCE_ICON[confidence]}>
          {CONFIDENCE_TEXT[confidence]}
        </LnBadge>
      </div>

      {/* Fields */}
      <LnCardBody>
        <dl className="m-0 flex flex-col gap-2">
          {fields.map((field) => (
            <div key={field.label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="text-[var(--color-ln-mute)]">{field.label}</dt>
              <dd className="m-0 text-right font-medium text-[var(--color-ln-ink)]">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      </LnCardBody>

      {/* Actions */}
      <div className="flex items-center gap-2.5 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-4 py-3">
        <LnButton variant="ghost" onClick={onEdit} className="flex-1">
          {editLabel}
        </LnButton>
        <LnButton variant="ok" onClick={onConfirm} className="flex-1">
          {confirmLabel}
        </LnButton>
      </div>
    </section>
  );
}
