"use client";

// ProvenanceCard — "¿De dónde sale este número?" for one catalogued KPI.
//
// Opened from the "Ver origen" affordance at the foot of OpKpi's ⓘ popover
// (only tiles carrying a `descriptorId` get it). A small, sober card on the
// native <dialog> element (same mechanics as components/ui/ConfirmDialog.tsx:
// browser focus trap, Escape via the native `cancel` event, focus-return to
// the trigger) — NOT a redesign; Op tokens only.
//
// THE CARD'S SIGNATURE IS ITS HONESTY: every line renders either the real
// datum the render site threaded, or an explicit "No disponible…" fallback.
// A missing datum is stated, never silently omitted, never faked.
//
// PRIVACY RULES (non-negotiable):
//   - The card CONSUMES verdicts. It never recomputes suppression, never
//     derives its own counts, and never renders an n for any scope narrower
//     than what the tile itself displays.
//   - The sample line renders ONLY the `n` the tile already feeds its guard
//     engine (OpKpi's `guardInput.n`). Below the anonymity floor (ANONYMITY_K,
//     or the descriptor's own smallN floor if higher) the LITERAL NUMBER is
//     never shown — only the withheld-for-privacy sentence.

import { useEffect, useRef, useState } from "react";

import { OpButton } from "@/components/ui/dashboard/OpButton";
import { ANONYMITY_K } from "@/lib/metrics/anonymity";
import { KPI_CATALOG, type KpiId } from "@/lib/metrics/kpi-catalog";
import { describeWindowBasisEs, getKpiProvenance } from "@/lib/metrics/kpi-provenance";
import { formatCount, formatDateTime } from "@/lib/utils/format";

/** Live view context a render site can thread — every field optional; each
 *  line has an honest fallback when its datum isn't threaded. */
export type ProvenanceContext = {
  /** Scope in view (e.g. "Buenos Aires — La Plata"). */
  scopeLabel?: string;
  /** Live period label when the page has a period picker. */
  periodLabel?: string;
  /** ISO timestamp of the data's freshness (e.g. panorama's dataAsOf). */
  dataAsOf?: string;
  /** The page renders DashboardFreshnessFooter — freshness defers to it. */
  pageHasFreshnessFooter?: boolean;
};

export type ProvenanceCardProps = {
  descriptorId: KpiId;
  open: boolean;
  onClose: () => void;
  /** Focus returns here on close (the ⓘ trigger). */
  triggerRef?: React.RefObject<HTMLElement | null>;
  context?: ProvenanceContext;
  /** The SAME sample size the tile feeds its guard engine (guardInput.n). */
  n?: number;
  /** OpKpi's already-resolved period-invariant verdict — threaded, not recomputed. */
  periodInvariant?: boolean;
};

/** The sample line's copy — exported for tests. NEVER returns a literal digit
 *  below the withhold floor. */
export function sampleLineEs(descriptorId: KpiId, n: number | undefined): string {
  if (n === undefined) return "No disponible en esta vista.";
  const descriptor = KPI_CATALOG[descriptorId];
  const floor = Math.max(ANONYMITY_K, descriptor.guards?.smallN?.min ?? 0);
  if (n < floor) return `Menos de ${floor} registros — se oculta por privacidad.`;
  return `${formatCount(n)} registros.`;
}

function Line({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-[0.08em] text-ln-op-mute">{term}</dt>
      <dd className="mt-0.5 text-sm leading-snug text-ln-op-ink">{children}</dd>
    </div>
  );
}

export function ProvenanceCard({
  descriptorId,
  open,
  onClose,
  triggerRef,
  context,
  n,
  periodInvariant,
}: ProvenanceCardProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`provenance-title-${Math.random().toString(36).slice(2)}`).current;
  const wasOpenRef = useRef(false);
  const [copied, setCopied] = useState(false);

  const descriptor = KPI_CATALOG[descriptorId];
  const provenance = getKpiProvenance(descriptorId);

  // Open/close the native dialog imperatively (ConfirmDialog pattern).
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open]);

  // Native cancel (Escape) → React state.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener("cancel", handleCancel);
    return () => el.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  // Focus-return to the trigger — only on a real open→close transition
  // (ConfirmDialog's wasOpenRef gate, same mount-storm rationale).
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current && triggerRef?.current) {
      triggerRef.current.focus();
    }
  }, [open, triggerRef]);

  // CopyViewButton's mechanism verbatim: the live URL already carries every
  // filter (period/jurisdiction axes are searchParams), so copying it IS the
  // reproducible view. Read at click time — no SSR mismatch.
  const copyLink = () => {
    if (typeof window === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => {
        // Clipboard denied — the URL stays shareable from the address bar.
      },
    );
  };

  const scopeLine = context?.scopeLabel ?? "Según los filtros de la vista actual.";
  const periodLine =
    context?.periodLabel ?? describeWindowBasisEs(descriptor.window, descriptor.basis);
  const freshnessLine = context?.dataAsOf
    ? formatDateTime(context.dataAsOf)
    : context?.pageHasFreshnessFooter
      ? "Ver pie de página."
      : "No disponible.";

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the onClick is not an action — it only cancels the ancestor <a>'s native navigation (see comment below); keyboard dismissal is the native `cancel` (Escape) listener above.
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-modal="true"
      onClose={onClose}
      // Anchor-descendant hazard (Cowork B6, same as OpKpi's ⓘ): when the tile
      // is wrapped in <a href>, any click inside this dialog would still
      // activate the ancestor anchor's native navigation. preventDefault
      // cancels it; no control in here relies on a default click action.
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={[
        "m-auto w-full max-w-[400px] rounded-[var(--radius-md)] p-0",
        "border border-ln-op-line bg-ln-op-card text-left shadow-lg",
        "[&::backdrop]:bg-black/40",
      ].join(" ")}
    >
      <div className="px-5 pt-5 pb-4">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Origen del dato
        </p>
        <h2 id={titleId} className="mt-1 text-base font-semibold leading-snug text-ln-op-ink">
          {descriptor.label}
        </h2>
        {descriptor.question && (
          <p className="mt-1 text-sm leading-snug text-ln-op-mute">{descriptor.question}</p>
        )}

        <dl className="mt-4 space-y-3">
          <Line term="Fórmula">{provenance.formulaEs}</Line>
          {/* NO "Fuente" LINE HERE, and the reason is worth keeping because it
              was tried and reverted on 2026-09-16.
              A metric-honesty audit observed that the catalog curates a `source`
              per KPI and that this card, whose whole premise is "¿de dónde sale
              este número?", never shows it — and called wiring it up a
              wording-only change. It is not. `descriptor.source` is an
              ENGINEERING field: "pets (denormalized pregnancy_status column)",
              "derivado de fetchCrossJurisdictionOutliers vía
              countAlertedProvinces", "pet_events (VET_ACTIVITY_EVENT_TYPES)".
              Rendering it puts column names, TS constants and a repo file path
              in front of a funcionario.
              The sharpest proof that this is a real boundary and not taste:
              AdminPoblacionScreen.test.tsx asserts the rendered page never
              contains "pregnancy_status" (qa-triage-2026-07-23 finding #9). That
              test still passed with the line in, because OpKpi lazy-mounts this
              card — so the string was one click away from the screen whose test
              forbids it.
              kpi-provenance.ts:1-15 already drew this line: the Fórmula comes
              from `formulaEs`, curated es-AR prose, and NOT from the catalog,
              precisely because the catalog's fields are SQL-ish shorthand.
              A source line belongs on this card. It needs a curated `sourceEs`
              beside `formulaEs`, where completeness is compiler-enforced — not
              a passthrough of the engineering string. */}
          <Line term="Alcance">{scopeLine}</Line>
          <Line term="Período / base temporal">
            {periodLine}
            {periodInvariant && (
              <span className="block text-xs text-ln-op-mute">No varía con el período.</span>
            )}
          </Line>
          <Line term="Muestra (n)">{sampleLineEs(descriptorId, n)}</Line>
          <Line term="Frescura">{freshnessLine}</Line>
        </dl>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-ln-op-line bg-ln-op-stripe px-5 py-3">
        <OpButton
          variant="ghost"
          size="sm"
          onClick={copyLink}
          className="-mx-1 px-1 text-left text-xs font-medium text-ln-op-azul hover:underline"
        >
          {copied ? "Enlace copiado" : "Copiar enlace de esta vista (requiere acceso al sistema)"}
        </OpButton>
        <OpButton variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </OpButton>
      </div>
    </dialog>
  );
}
