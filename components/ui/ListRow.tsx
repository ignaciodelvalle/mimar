import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

// LnListRow — minimal shared primitive for a simple "icon + label/meta +
// trailing" list row (design-islands audit, consistency/list-primitive).
//
// CasesWidget.tsx and FutureLedgerList.tsx had independently hand-rolled the
// identical row shape — optional leading icon, a min-w-0 flex-1 content
// block, a shrink-0 trailing slot, with the whole row optionally wrapped in
// a Link — as three/four separate `<li>` implementations. None of the
// existing list primitives fit: `LnRegRow` (RegRow.tsx) is pet-registry
// specific (fixed photo + status-dot + species chevron shape); `LnLedger`
// (Ledger.tsx) is a typed `<table>` for columnar data; `CaseQueue`
// (dashboard/CaseQueue.tsx) is a full operator table with bulk-select and
// filter chips. This row is deliberately dumber than all three.
//
// Ownership split: this component owns ONLY the row's structural layout
// (flex direction, gaps, alignment, optional Link wrap). It does NOT own
// typography or color — icon/children/trailing are fully caller-styled
// ReactNode, so citizen (`ln-*`) and operator (`ln-op-*`) skins can both
// use it without a skin prop, and each call site keeps its exact existing
// classes (pixel-parity on migration).
//
// No "use client" — purely presentational; every current call site renders
// it from within a component that already owns its own client boundary.

export type LnListRowAlign = "start" | "center";

const ALIGN_CLASSES: Record<LnListRowAlign, string> = {
  start: "items-start",
  center: "items-center",
};

type LinkProps = ComponentProps<typeof Link>;

export type LnListRowProps = {
  /** Optional leading icon/avatar — pass an already-styled element (size, bg, radius are the caller's). */
  icon?: ReactNode;
  /** Main content — label + meta stack. Rendered in a min-w-0 flex-1 wrapper. */
  children: ReactNode;
  /** Optional trailing slot — meta text, a link, or one or more action controls. Rendered shrink-0. */
  trailing?: ReactNode;
  /** When set, the whole row is a Link to this href. */
  href?: LinkProps["href"];
  prefetch?: LinkProps["prefetch"];
  /** Cross-axis alignment of icon/content/trailing. Defaults to "start" (matches multi-line rows). */
  align?: LnListRowAlign;
  /** Extra classes merged onto the row (spacing, hover, borders — NOT layout). */
  className?: string;
};

export function LnListRow({
  icon,
  children,
  trailing,
  href,
  prefetch,
  align = "start",
  className = "",
}: LnListRowProps) {
  const rowClasses = ["flex gap-3", ALIGN_CLASSES[align], className].filter(Boolean).join(" ");

  const inner = (
    <>
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </>
  );

  if (href) {
    return (
      <Link href={href} prefetch={prefetch} className={`${rowClasses} no-underline`}>
        {inner}
      </Link>
    );
  }

  return <div className={rowClasses}>{inner}</div>;
}
