import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

// LnLinkButton — shared "Link styled as a button" primitive (design-system
// audit finding 7, wave-3 D7). Three call sites hand-rolled the same azul
// filled-pill CTA independently (FutureLedgerList/ComplianceObligationsPanel
// byte-for-byte identical "Programar turno" link) plus a taller two-line
// block variant (TurnoAntirrabicaSheet, filled + outline siblings).
//
// Two independent axes instead of one combined variant enum, since the
// 3 sites actually vary along BOTH shape (pill vs block) and fill
// (filled azul vs outlined) independently:
//   - shape: "pill" (rounded-full, single line) | "block" (rounded-card,
//     supports an optional two-line title+subtitle via `subtitle`)
//   - fill: "filled" (azul bg, white text) | "outline" (bordered, azul text)
//
// No "use client" — every current call site renders this from a Server
// Component; Link itself needs no client boundary for a plain href.

export type LnLinkButtonShape = "pill" | "block";
export type LnLinkButtonFill = "filled" | "outline";

type LinkProps = ComponentProps<typeof Link>;

type Props = Omit<LinkProps, "className" | "children"> & {
  children: ReactNode;
  /** Second line — only meaningful with shape="block". */
  subtitle?: ReactNode;
  shape?: LnLinkButtonShape;
  fill?: LnLinkButtonFill;
  className?: string;
};

const SHAPE_CLASSES: Record<LnLinkButtonShape, string> = {
  pill: "rounded-full px-4",
  block: "rounded-[var(--radius-card)] px-4 py-2",
};

const FILL_CLASSES: Record<LnLinkButtonFill, string> = {
  filled: "bg-[var(--color-ln-azul)] text-white hover:bg-[var(--color-ln-azul-700)]",
  outline:
    "border border-[var(--color-ln-line-strong)] text-[var(--color-ln-azul)] hover:bg-[var(--color-ln-stripe)]",
};

const SUBTITLE_TONE: Record<LnLinkButtonFill, string> = {
  filled: "text-[var(--color-ln-celeste-050)]",
  outline: "text-[var(--color-ln-mute)]",
};

export function LnLinkButton({
  children,
  subtitle,
  shape = "pill",
  fill = "filled",
  className = "",
  ...rest
}: Props) {
  const hasSubtitle = shape === "block" && subtitle;

  return (
    <Link
      {...rest}
      className={[
        "inline-flex min-h-11 no-underline transition-colors font-ln-sans",
        hasSubtitle ? "flex-col items-start justify-center gap-0.5" : "items-center justify-center",
        SHAPE_CLASSES[shape],
        FILL_CLASSES[fill],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {hasSubtitle ? (
        <>
          <span className="text-sm font-semibold">{children}</span>
          <span className={["text-xs", SUBTITLE_TONE[fill]].join(" ")}>{subtitle}</span>
        </>
      ) : (
        <span className="text-sm font-semibold">{children}</span>
      )}
    </Link>
  );
}
