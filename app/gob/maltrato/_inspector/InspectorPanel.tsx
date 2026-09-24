"use client";

// InspectorPanel — the non-modal a11y shell for the master-detail inspector.
//
// Reuses the v3 RailPanel pattern (components/panorama/PanoramaRail.tsx:70-89,
// 156-195): a NON-MODAL floating/region panel — no <dialog>.showModal(), no
// focus trap — so the master list stays LIVE and in tab order underneath. The
// preverify explicitly chose this over hand-downgrading DetailDrawer's native
// <dialog> (still modal). RailPanel itself is coupled to the panorama rail
// (Simple/Detalle toggle, rail anchoring), so its a11y logic is re-expressed
// here for the inspector rather than imported.
//
// a11y contract (spec §Interaction & state preservation):
//   - on open, focus moves to the close button;
//   - Esc closes (→ shallow back via onClose); focus restoration to the
//     activated row is the mounter's responsibility (it owns the row registry);
//   - the list stays in tab order throughout (non-modal, no trap).
//
// Outside-click is deliberately NOT wired: on desktop the inspector is a
// persistent 60% column, not a transient popover — clicking the list to pick
// another case must select it, never dismiss the panel.

import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef } from "react";

import { Icon } from "@/components/Icon";
import { OpButton } from "@/components/ui/dashboard";

type Props = {
  /** Panel heading (es-AR) — case reference / pet name. */
  title: ReactNode;
  /** Escape-hatch full-page route ("◹ Abrir en página completa"). */
  fullPageHref?: string;
  /** Close the whole inspector (✕ / Esc → shallow back to the list). */
  onClose: () => void;
  /** Pet drill only: pop back to the case ("← Volver a la denuncia"). */
  onBack?: () => void;
  children: ReactNode;
};

export function InspectorPanel({ title, fullPageHref, onClose, onBack, children }: Props) {
  const sectionRef = useRef<HTMLElement>(null);
  const titleId = useId();

  // Move focus to the close button on open (non-modal — no trap). OpButton
  // forwards no ref, so we query the close control by its data hook.
  useEffect(() => {
    sectionRef.current?.querySelector<HTMLButtonElement>("[data-inspector-close]")?.focus();
  }, []);

  // Esc closes the inspector (→ shallow back). Non-modal: a single document
  // listener, the map/list underneath stays interactive.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      ref={sectionRef}
      aria-labelledby={titleId}
      className="flex h-full min-h-0 flex-col rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-card"
    >
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-ln-op-line px-4 py-3">
        {onBack && (
          <OpButton type="button" variant="ghost" size="sm" onClick={onBack}>
            ← Volver a la denuncia
          </OpButton>
        )}
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-md font-semibold text-ln-op-ink">
          {title}
        </h2>
        <div className="flex flex-shrink-0 items-center gap-2">
          {fullPageHref && (
            <Link
              href={fullPageHref}
              prefetch={false}
              className="inline-flex items-center gap-1 rounded-[var(--radius-md)] border border-ln-op-line px-2 py-1 text-sm text-ln-op-mute hover:bg-ln-op-stripe hover:text-ln-op-ink-2"
              title="Abrir en página completa"
            >
              <Icon name="externo" size="sm" decorative />
              Abrir en página completa
            </Link>
          )}
          <OpButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Cerrar inspector"
            data-inspector-close
          >
            <Icon name="close" size="sm" decorative />
          </OpButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}
