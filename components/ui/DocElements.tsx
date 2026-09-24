import type { ReactNode } from "react";

/**
 * Libreta Nacional Document Elements.
 *
 * LnGuilloche — 4px passport security band (repeating horizontal stripes)
 * LnDocCode   — mono metadata label (right side of sub-bar)
 * LnSeal      — rotated -9° "Registro Nacional" circle stamp
 * LnLabel     — mono uppercase hairline label (used inside cards)
 */

// ---------- Guilloché band ------------------------------------------------

export function LnGuilloche({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={[
        "h-[4px] flex-shrink-0",
        // Security pattern: repeating 2px azul stripes on celeste base
        "[background:repeating-linear-gradient(90deg,var(--color-ln-azul)_0_2px,transparent_2px_4px),var(--color-ln-celeste)]",
        "opacity-90",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
}

// ---------- DocCode -------------------------------------------------------

export type LnDocCodeProps = {
  children: ReactNode;
  className?: string;
};

export function LnDocCode({ children, className = "" }: LnDocCodeProps) {
  return (
    <span
      className={[
        "ml-auto font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-faint)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

// ---------- Seal ----------------------------------------------------------

export type LnSealProps = {
  /** Main text inside the circle (defaults to "Registro Nacional") */
  line1?: string;
  line2?: string;
  size?: number;
  className?: string;
};

export function LnSeal({
  line1 = "Registro",
  line2 = "Nacional",
  size = 54,
  className = "",
}: LnSealProps) {
  return (
    <div
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={[
        "grid flex-shrink-0 place-items-center rounded-full border-2 border-[var(--color-ln-azul)] text-center",
        "font-ln-mono text-[7px] uppercase leading-[1.25] tracking-[.06em] text-[var(--color-ln-azul)]",
        "-rotate-9 opacity-82",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span>
        {line1}
        {line2 && (
          <>
            <br />
            {line2}
          </>
        )}
      </span>
    </div>
  );
}

// ---------- Label (mono hairline) ----------------------------------------

export function LnLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={[
        "font-ln-mono text-xs font-semibold uppercase tracking-[.14em] text-[var(--color-ln-mute)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}

// ---------- Section heading (numbered) ------------------------------------

export type LnSectionHeadProps = {
  num?: string;
  title: string;
  meta?: ReactNode;
  className?: string;
};

export function LnSectionHead({ num, title, meta, className = "" }: LnSectionHeadProps) {
  return (
    <div
      className={[
        "mb-4 flex items-baseline gap-3.5 border-b-2 border-[var(--color-ln-ink)] pb-2.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {num && (
        <span className="font-ln-mono text-sm font-semibold tracking-[.04em] text-[var(--color-ln-azul)]">
          {num}
        </span>
      )}
      <h2 className="m-0 font-ln-serif text-title font-semibold tracking-[-0.01em] text-[var(--color-ln-ink)]">
        {title}
      </h2>
      {meta && (
        <span className="ml-auto self-center font-ln-mono text-sm tracking-[.02em] text-[var(--color-ln-mute)]">
          {meta}
        </span>
      )}
    </div>
  );
}

// ---------- Callout banner ------------------------------------------------

export type LnCalloutTone = "azul" | "warn" | "danger";

export type LnCalloutProps = {
  tone?: LnCalloutTone;
  title?: string;
  children: ReactNode;
  className?: string;
};

export function LnCallout({ tone = "azul", title, children, className = "" }: LnCalloutProps) {
  const colors =
    tone === "danger"
      ? "bg-[var(--color-ln-err-050)] border-[var(--color-ln-err-100)] [border-left-color:var(--color-ln-err)]"
      : tone === "warn"
        ? "bg-[var(--color-ln-warn-025)] border-[var(--color-ln-warn-100)] [border-left-color:var(--color-ln-warn)]"
        : "bg-[var(--color-ln-celeste-050)] border-[var(--color-ln-celeste-100)] [border-left-color:var(--color-ln-azul)]";

  return (
    <div
      className={["rounded-[var(--radius-sm)] border border-l-[3px] px-3.5 py-3", colors, className]
        .filter(Boolean)
        .join(" ")}
    >
      {title && (
        <p className="mb-1 flex items-center gap-[7px] text-md font-semibold text-[var(--color-ln-ink)]">
          {title}
        </p>
      )}
      <p className="text-sm leading-[1.5] text-[var(--color-ln-ink-2)]">{children}</p>
    </div>
  );
}
