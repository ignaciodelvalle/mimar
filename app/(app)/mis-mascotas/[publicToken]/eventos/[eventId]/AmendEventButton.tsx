"use client";

// AmendEventButton — "Corregir" affordance on the event detail page.
//
// Renders only when:
//   1. The event type is in the amendable allowlist (D4).
//   2. The current viewer has write capability (D3).
//
// Opens the AmendEventForm sheet/modal inline.

import { Icon } from "@/components/Icon";
import type { EventType } from "@/db/schema";
import { isAmendableEventType } from "@/lib/infra/amendment";
import { useRef, useState } from "react";
import { AmendEventForm } from "./AmendEventForm";

export type AmendEventButtonProps = {
  eventId: string;
  eventType: EventType | string;
  /** Pre-filled current payload for the form. */
  currentPayload: Record<string, unknown>;
  /** True when the viewer has write access to pet events (owner path). */
  canAmend: boolean;
  publicToken: string;
};

export function AmendEventButton({
  eventId,
  eventType,
  currentPayload,
  canAmend,
  publicToken,
}: AmendEventButtonProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // D4: allowlist check + D3: capability check.
  if (!isAmendableEventType(eventType) || !canAmend) {
    return null;
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(true)}
        className={[
          "inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)]",
          "bg-[var(--color-ln-card)] px-3.5 py-2",
          "font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-ink-2)]",
          "hover:bg-[var(--color-ln-stripe)] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)]",
          "min-h-[44px]",
        ].join(" ")}
        aria-label="Corregir este registro"
      >
        <Icon name="editar" size={12} decorative />
        Corregir registro
      </button>

      {open && (
        <AmendEventForm
          eventId={eventId}
          eventType={eventType}
          currentPayload={currentPayload}
          publicToken={publicToken}
          onClose={() => setOpen(false)}
          triggerRef={btnRef}
        />
      )}
    </>
  );
}
