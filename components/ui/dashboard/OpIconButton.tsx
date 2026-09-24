"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * OpIconButton — the operator chrome's icon-only button primitive.
 *
 * Extracted during the mobile-polish batch (visual review 2026-07-23): topbar
 * chrome kept hand-rolling 40px icon button elements (the AppShellDrawer
 * hamburger being the grandfathered original), each re-inventing hit-area,
 * border and focus treatment. This is the shared primitive
 * check-raw-buttons.mjs points new icon-chrome at — ONE raw button element
 * here instead of one per call site.
 *
 * `aria-label` is REQUIRED: an icon-only control is invisible to screen
 * readers without it.
 */
type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  "aria-label": string;
  children: ReactNode;
  /** Bordered chrome (topbar trigger) vs borderless (inline close). */
  bordered?: boolean;
};

export function OpIconButton({ bordered = false, className = "", type, children, ...rest }: Props) {
  return (
    <button
      type={type ?? "button"}
      className={[
        "inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ln-op-azul",
        bordered
          ? "border border-ln-op-line text-ln-op-ink hover:border-ln-op-line-2"
          : "text-ln-op-mute hover:text-ln-op-ink",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
