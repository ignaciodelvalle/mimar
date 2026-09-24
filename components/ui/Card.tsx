import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";

/**
 * Libreta Nacional Card + Sheet frame.
 *
 * LnCard      — near-flat card (1px border, 0 1px 0 shadow)
 * LnCardHead  — card header with optional label slot
 * LnCardBody  — card body padding
 *
 * LnSheet     — modal/drawer document frame:
 *   - paper bg + dotted backdrop
 *   - white card, route chip mono, 3px category top-border + icon + serif title + close
 *   - body, sticky stripe footer
 *
 * LnSheetPet  — pet selector strip (inside a sheet):
 *   - stripe bg, photo + serif name + meta + "CAMBIAR" link
 *
 * Tone for LnSheet header top-border:
 *   azul (default) | verde | warn | violeta | seal
 */

// ---------- Card ----------------------------------------------------------

export type LnCardProps = {
  className?: string;
  children: ReactNode;
  "aria-labelledby"?: string;
};

export function LnCard({
  className = "",
  children,
  "aria-labelledby": ariaLabelledBy,
}: LnCardProps) {
  return (
    <div
      aria-labelledby={ariaLabelledBy}
      className={[
        "overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] shadow-[0_1px_0_rgba(0,0,0,.02)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

export type LnCardHeadProps = {
  title: ReactNode;
  label?: ReactNode;
  icon?: ReactNode;
  /** Optional right-aligned action slot (buttons, links, etc.). */
  actions?: ReactNode;
  className?: string;
};

export function LnCardHead({ title, label, icon, actions, className = "" }: LnCardHeadProps) {
  return (
    <div
      className={[
        "flex items-center gap-2 border-b border-[var(--color-ln-line-2)] px-4 py-3",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && <span className="text-[var(--color-ln-mute)]">{icon}</span>}
      <h3 className="m-0 font-ln-serif text-base font-semibold leading-tight text-[var(--color-ln-ink)]">
        {title}
      </h3>
      {(label || actions) && (
        <div className="ml-auto flex items-center gap-2">
          {label && (
            <span className="font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-[var(--color-ln-mute)]">
              {label}
            </span>
          )}
          {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
        </div>
      )}
    </div>
  );
}

export function LnCardBody({ className = "", children }: LnCardProps) {
  return <div className={["px-4 py-3.5", className].filter(Boolean).join(" ")}>{children}</div>;
}

// ---------- Sheet frame ---------------------------------------------------

export type LnSheetTone = "azul" | "verde" | "warn" | "violeta" | "seal";

const toneTopBorder: Record<LnSheetTone, string> = {
  azul: "border-t-[var(--color-ln-azul)]",
  verde: "border-t-[var(--color-ln-ok)]",
  warn: "border-t-[var(--color-ln-warn)]",
  violeta: "border-t-[var(--color-ln-violeta)]",
  seal: "border-t-[var(--color-ln-seal)]",
};

const toneIconColors: Record<LnSheetTone, string> = {
  azul: "bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)] border-[var(--color-ln-celeste-100)]",
  verde: "bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)] border-[var(--color-ln-ok-100)]",
  warn: "bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)] border-[var(--color-ln-warn-100)]",
  violeta:
    "bg-[var(--color-ln-violeta-050)] text-[var(--color-ln-violeta)] border-[var(--color-ln-violeta-100)]",
  seal: "bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)] border-[var(--color-ln-err-100)]",
};

export type LnSheetProps = {
  tone?: LnSheetTone;
  routeChip?: string;
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  onClose?: () => void;
  footer?: ReactNode;
  wide?: boolean;
  children: ReactNode;
  className?: string;
};

export function LnSheet({
  tone = "azul",
  routeChip,
  icon,
  title,
  subtitle,
  onClose,
  footer,
  wide = false,
  children,
  className = "",
}: LnSheetProps) {
  return (
    // Dotted paper backdrop
    <div
      className={[
        "relative flex min-h-full w-full items-start justify-center overflow-auto px-6 py-7",
        "font-ln-sans text-[var(--color-ln-ink)]",
        // Dotted backdrop pattern
        "[background:radial-gradient(circle_at_12px_12px,var(--color-ln-line)_1.2px,transparent_1.2px)_0_0/22px_22px,var(--color-ln-paper)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Route chip */}
      {routeChip && (
        <span className="absolute left-[var(--space-sheet)] top-3 rounded-full border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-2.5 py-1 font-ln-mono text-xs tracking-[.08em] text-[var(--color-ln-faint)]">
          {routeChip}
        </span>
      )}

      {/* Card */}
      <div
        className={[
          "flex w-full flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] shadow-[0_18px_50px_rgba(20,40,60,.14)]",
          wide ? "max-w-[620px]" : "max-w-[560px]",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Header */}
        <div
          className={[
            "flex items-center gap-3.5 border-b border-[var(--color-ln-line)] border-t-[3px] px-[var(--space-sheet)] py-4",
            toneTopBorder[tone],
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {/* Icon badge */}
          {icon && (
            <div
              className={[
                "grid h-[38px] w-[38px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] border text-base",
                toneIconColors[tone],
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {icon}
            </div>
          )}

          {/* Title */}
          <div className="min-w-0 flex-1">
            <h2 className="m-0 font-ln-serif text-lg font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">{subtitle}</p>}
          </div>

          {/* Close button */}
          {onClose && (
            <button
              type="button"
              aria-label="Cerrar"
              onClick={onClose}
              // 30px box, 44px target — see the twin in Sheet.tsx for why the
              // box does not simply grow.
              className="relative grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] text-[var(--color-ln-mute)] transition-colors after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] hover:bg-[var(--color-ln-stripe)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
            >
              <Icon name="close" size="sm" decorative />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="flex flex-col gap-3.5 p-[var(--space-sheet)]">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center gap-2.5 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-[var(--space-sheet)] py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Sheet pet selector strip -------------------------------------

export type LnSheetPetProps = {
  /** Photo element or placeholder (pass an <img> or null) */
  photo?: ReactNode;
  name: string;
  meta?: string;
  /** Called when user clicks "CAMBIAR" */
  onChangePet?: () => void;
  className?: string;
};

/**
 * LnSheetPet — pet selector row used at the top of a LnSheet body.
 *
 * Layout: [photo] [serif name + mono meta] [CAMBIAR →]
 * Background: ln-stripe, 1px ln-line border, radius 4px.
 */
export function LnSheetPet({ photo, name, meta, onChangePet, className = "" }: LnSheetPetProps) {
  return (
    <div
      className={[
        "flex items-center gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-3 py-2.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Photo */}
      {photo && (
        <div className="h-[40px] w-[40px] flex-shrink-0 overflow-hidden rounded-full">{photo}</div>
      )}

      {/* Text */}
      <div className="min-w-0 flex-1">
        <p className="m-0 font-ln-serif text-base font-semibold leading-tight text-[var(--color-ln-ink)]">
          {name}
        </p>
        {meta && <p className="mt-px text-sm text-[var(--color-ln-mute)]">{meta}</p>}
      </div>

      {/* Change link */}
      {onChangePet && (
        <button
          type="button"
          onClick={onChangePet}
          className="flex-shrink-0 cursor-pointer font-ln-mono text-xs tracking-[.04em] text-[var(--color-ln-azul)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)]"
        >
          CAMBIAR
        </button>
      )}
    </div>
  );
}
