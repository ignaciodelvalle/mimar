"use client";

import Image from "next/image";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

/**
 * Libreta Nacional Sheet frame.
 *
 * Replaces the poncho Vaul-based Sheet for owner event forms.
 * Rendered as a full-page surface (not a modal) — it occupies the
 * scrollable content area of the shell, not a portal overlay.
 *
 * Layout layers (per handoff §8–11):
 *   LnSheetWrap       — paper bg with dotted backdrop; centers the card
 *   LnSheet           — white card; 3px category top-border; shadow
 *   LnSheetHeader     — route chip + icon box + serif title + subtitle + close
 *   LnSheetBody       — scrollable content area
 *   LnSheetFooter     — sticky stripe footer: Cancelar + primary CTA
 *
 * Category color → tone prop:
 *   "azul"    #0e5a99  (default — general events)
 *   "verde"   #2e7d4f  (vacuna)
 *   "violeta" #6b4ea8  (medicación)
 *   "seal"    #a23a2c  (perdida)
 *   "warn"    #96600e  (cautionary)
 *
 * Usage:
 *   <LnSheetPage
 *     tone="verde"
 *     icon={<Icon name="vacuna" decorative />}
 *     title="Registrar vacuna"
 *     subtitle="Libreta sanitaria"
 *     routeChip="?asiento=vacuna"
 *     onClose={() => router.back()}
 *   >
 *     <form ...>...</form>
 *   </LnSheetPage>
 *
 * Accessibility:
 *  - header contains role="heading" aria-level="1" for the title
 *  - close button has aria-label="Cerrar"
 *  - footer's cancel button triggers onClose
 *
 * All styles use ln-* tokens. Safe in components/ui/ (exempt from lint:tokens guard).
 */

// ---------- Tone styles --------------------------------------------------

export type LnSheetTone = "azul" | "verde" | "violeta" | "seal" | "warn" | "rosa";

const toneTopBorder: Record<LnSheetTone, string> = {
  azul: "border-t-[var(--color-ln-azul)]",
  verde: "border-t-[var(--color-ln-ok)]",
  violeta: "border-t-[var(--color-ln-violeta)]",
  seal: "border-t-[var(--color-ln-seal)]",
  warn: "border-t-[var(--color-ln-warn)]",
  rosa: "border-t-[var(--color-ln-rosa)]",
};

const toneIconBg: Record<LnSheetTone, string> = {
  azul: "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)] border-[var(--color-ln-celeste-100)]",
  verde: "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)] border-[var(--color-ln-ok-100)]",
  violeta:
    "bg-[var(--color-ln-violeta-050)] text-[var(--color-ln-violeta)] border-[var(--color-ln-violeta-100)]",
  seal: "bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)] border-[var(--color-ln-err-100)]",
  warn: "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)] border-[var(--color-ln-warn-100)]",
  rosa: "bg-[var(--color-ln-rosa-050)] text-[var(--color-ln-rosa)] border-[var(--color-ln-rosa-100)]",
};

const toneCtaClass: Record<LnSheetTone, string> = {
  azul: "bg-[var(--color-ln-azul)] border-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700)] hover:border-[var(--color-ln-azul-700)]",
  verde: "bg-[var(--color-ln-ok)] border-[var(--color-ln-ok)] hover:opacity-90",
  violeta: "bg-[var(--color-ln-violeta)] border-[var(--color-ln-violeta)] hover:opacity-90",
  seal: "bg-[var(--color-ln-seal)] border-[var(--color-ln-seal)] hover:opacity-90",
  warn: "bg-[var(--color-ln-warn)] border-[var(--color-ln-warn)] hover:opacity-90",
  rosa: "bg-[var(--color-ln-rosa)] border-[var(--color-ln-rosa)] hover:opacity-90",
};

// ---------- LnSheetPage (full page composition) --------------------------

export type LnSheetPageProps = {
  tone?: LnSheetTone;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  routeChip?: string;
  onClose?: () => void;
  /** CTA label in footer (defaults to "Guardar") */
  ctaLabel?: string;
  /** Form id — footer submit button targets this form by id */
  formId?: string;
  /** Whether the form is currently submitting */
  isPending?: boolean;
  /** Override the pending-state label (default: "Registrando…") */
  pendingLabel?: string;
  wide?: boolean;
  children: ReactNode;
};

export function LnSheetPage({
  tone = "azul",
  icon,
  title,
  subtitle,
  routeChip,
  onClose,
  ctaLabel = "Guardar",
  formId,
  isPending = false,
  pendingLabel,
  wide = false,
  children,
}: LnSheetPageProps) {
  return (
    <LnSheetWrap>
      {routeChip && <LnSheetRouteChip>{routeChip}</LnSheetRouteChip>}
      <LnSheetCard wide={wide}>
        <LnSheetHeader
          tone={tone}
          icon={icon}
          title={title}
          subtitle={subtitle}
          onClose={onClose}
        />
        <LnSheetBody>{children}</LnSheetBody>
        <LnSheetFooter
          tone={tone}
          ctaLabel={ctaLabel}
          formId={formId}
          isPending={isPending}
          pendingLabel={pendingLabel}
          onCancel={onClose}
        />
      </LnSheetCard>
    </LnSheetWrap>
  );
}

// ---------- LnSheetWrap --------------------------------------------------

export function LnSheetWrap({ children }: { children: ReactNode }) {
  return (
    <div
      className={[
        "relative flex min-h-screen w-full items-start justify-center overflow-auto",
        "bg-[radial-gradient(circle_at_12px_12px,var(--color-ln-line)_1.2px,transparent_1.2px)_0_0_/_22px_22px,var(--color-ln-paper)]",
        "px-6 py-7",
        "font-ln-sans text-[var(--color-ln-ink)]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

// ---------- LnSheetCard --------------------------------------------------

export function LnSheetCard({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={[
        "flex flex-col overflow-hidden rounded-[var(--radius-md)]",
        "border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)]",
        "shadow-[0_18px_50px_rgba(20,40,60,.14)]",
        "w-full",
        wide ? "max-w-[620px]" : "max-w-[560px]",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

// ---------- LnSheetRouteChip ---------------------------------------------

export function LnSheetRouteChip({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-[18px] top-[12px] rounded-full border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-2.5 py-[3px] font-ln-mono text-xs tracking-[.08em] text-[var(--color-ln-faint)]">
      {children}
    </div>
  );
}

// ---------- LnSheetHeader ------------------------------------------------

export type LnSheetHeaderProps = {
  tone?: LnSheetTone;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  onClose?: () => void;
};

export function LnSheetHeader({
  tone = "azul",
  icon,
  title,
  subtitle,
  onClose,
}: LnSheetHeaderProps) {
  return (
    <div
      className={[
        "relative flex items-center gap-[13px] border-b border-[var(--color-ln-line)] border-t-[3px] px-[18px] py-4",
        toneTopBorder[tone],
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Icon box */}
      {icon && (
        <div
          className={[
            "grid h-[38px] w-[38px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] border text-base",
            toneIconBg[tone],
          ]
            .filter(Boolean)
            .join(" ")}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}

      {/* Text */}
      <div className="min-w-0 flex-1">
        <h1 className="m-0 font-ln-serif text-lg font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">{subtitle}</p>}
      </div>

      {/* Close */}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar"
          // The box stays 30px because the header's density depends on it; the
          // TARGET is grown to 44 with a centred pseudo-element, which is what
          // WCAG 2.5.5 actually measures. Growing the box instead would have
          // resized every sheet header in the app to fix a thing nobody can see.
          // The focus ring is new too: this button had none while its twin in
          // Card.tsx did, so a keyboard user closing a sheet was aiming blind.
          className="relative grid h-[30px] w-[30px] flex-shrink-0 cursor-pointer place-items-center rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] text-[var(--color-ln-mute)] transition-colors after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] hover:bg-[var(--color-ln-stripe)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
        >
          <Icon name="close" size="sm" decorative />
        </button>
      )}
    </div>
  );
}

// ---------- LnSheetBody --------------------------------------------------

export function LnSheetBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3.5 px-[18px] py-[18px]">{children}</div>;
}

// ---------- LnSheetFooter ------------------------------------------------

export type LnSheetFooterProps = {
  tone?: LnSheetTone;
  ctaLabel?: string;
  formId?: string;
  isPending?: boolean;
  onCancel?: () => void;
  /** Render a custom CTA instead of the default submit button */
  customCta?: ReactNode;
  /**
   * Wave 2 Item 9: override the "Registrando…" pending label.
   * Defaults to "Registrando…" for event-log forms.
   * Pass "Guardando…" for profile-edit or other non-event contexts.
   */
  pendingLabel?: string;
};

export function LnSheetFooter({
  tone = "azul",
  ctaLabel = "Guardar",
  formId,
  isPending = false,
  onCancel,
  customCta,
  pendingLabel = "Registrando…",
}: LnSheetFooterProps) {
  return (
    // Wave 2 Item 9: sticky footer so the primary CTA stays reachable with the
    // thumb on mobile even with long forms.
    // pb-safe keeps the CTA above the iOS home indicator in the installed PWA
    // (viewport-fit=cover; see globals.css safe-area utilities).
    <div className="pb-safe sticky bottom-0 z-10 flex items-center gap-2.5 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-[18px] py-[13px]">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3.5 py-2 text-md font-semibold text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)] active:scale-[0.98] active:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Cancelar
        </button>
      )}
      <div className="flex-1" />
      {customCta ?? (
        <button
          type="submit"
          form={formId}
          disabled={isPending}
          aria-busy={isPending || undefined}
          className={[
            "inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border px-4 py-[9px] text-md font-semibold text-white transition-colors",
            "active:scale-[0.98] active:opacity-90",
            "disabled:cursor-not-allowed disabled:opacity-60",
            toneCtaClass[tone],
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {isPending ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              />
              {pendingLabel}
            </>
          ) : (
            ctaLabel
          )}
        </button>
      )}
    </div>
  );
}

// ---------- LnSheetPetRow ------------------------------------------------

/**
 * Pet selector strip shown at the top of the sheet body.
 * Displays photo (or placeholder), name, meta info, and a "CAMBIAR" affordance.
 */
export type LnSheetPetRowProps = {
  name: string;
  meta?: string;
  photoUrl?: string | null;
  onChangePet?: () => void;
};

export function LnSheetPetRow({ name, meta, photoUrl, onChangePet }: LnSheetPetRowProps) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3 py-2.5">
      {/* Photo / placeholder */}
      <div className="h-[38px] w-[38px] flex-shrink-0 overflow-hidden rounded-full border border-[var(--color-ln-line-strong)]">
        {photoUrl ? (
          <Image src={photoUrl} alt={name} fill sizes="38px" className="object-cover" />
        ) : (
          <div className="h-full w-full bg-[repeating-linear-gradient(135deg,var(--pattern-no-photo-a)_0_4px,var(--pattern-no-photo-b)_4px_8px)]" />
        )}
      </div>
      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <p className="font-ln-serif text-base font-semibold leading-tight text-[var(--color-ln-ink)]">
          {name}
        </p>
        {meta && <p className="mt-px text-sm text-[var(--color-ln-mute)]">{meta}</p>}
      </div>
      {/* Change */}
      {onChangePet && (
        <button
          type="button"
          onClick={onChangePet}
          className="ml-auto cursor-pointer font-ln-mono text-xs tracking-[.04em] text-[var(--color-ln-azul)]"
        >
          CAMBIAR
        </button>
      )}
    </div>
  );
}

// ---------- LnSubCard ----------------------------------------------------

/**
 * Grouped field card (enriched identity sub-card, disclosure prefs sub-card).
 */
export type LnSubCardProps = {
  heading?: string;
  children: ReactNode;
  className?: string;
};

export function LnSubCard({ heading, children, className = "" }: LnSubCardProps) {
  return (
    <div
      className={[
        "flex flex-col gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-paper)] px-3.5 py-3.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {heading && (
        <p className="border-b border-[var(--color-ln-line-2)] pb-[7px] font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-azul)]">
          {heading}
        </p>
      )}
      {children}
    </div>
  );
}

// ---------- LnGroupLabel -------------------------------------------------

export function LnGroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.12em] text-[var(--color-ln-faint)]">
      {children}
    </p>
  );
}

// ---------- LnSheetAccordion ----------------------------------------------

/**
 * Numbered <details> accordion for the Editar mascota sheet.
 * Shows "✓ completo" when closed (if complete={true}).
 */
export type LnSheetAccordionProps = {
  num: string;
  title: string;
  defaultOpen?: boolean;
  complete?: boolean;
  children: ReactNode;
};

export function LnSheetAccordion({
  num,
  title,
  defaultOpen = false,
  complete = false,
  children,
}: LnSheetAccordionProps) {
  return (
    <details
      open={defaultOpen}
      className="op-disclosure group rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]"
    >
      <summary className="flex cursor-pointer select-none list-none items-center gap-3 px-3.5 py-[11px] hover:bg-[var(--color-ln-stripe)]">
        {/* Number */}
        <span className="font-ln-mono text-sm font-semibold tracking-[.04em] text-[var(--color-ln-azul)]">
          {num}
        </span>
        {/* Title */}
        <span className="flex-1 text-md font-semibold text-[var(--color-ln-ink)]">{title}</span>
        {/* Complete badge — hidden when open */}
        {complete && (
          <span className="inline-flex items-center gap-1 font-ln-mono text-xs text-[var(--color-ln-ok)] group-open:hidden">
            <Icon name="check" size={14} decorative /> completo
          </span>
        )}
        {/* Chevron */}
        <span
          aria-hidden="true"
          className="text-[var(--color-ln-mute)] transition-transform duration-150 group-open:rotate-90"
        >
          ›
        </span>
      </summary>
      <div className="border-t border-[var(--color-ln-line-2)] px-3.5 py-3.5">{children}</div>
    </details>
  );
}
