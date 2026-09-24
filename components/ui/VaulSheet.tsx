"use client";

import { Icon } from "@/components/Icon";
import { getDrawerWidth } from "@/lib/ui/sheet-helpers";
import type { ReactNode, RefObject } from "react";
import { useEffect } from "react";
import { Drawer } from "vaul";

export type { SheetSize } from "@/lib/ui/sheet-helpers";

export type SheetSide = "bottom" | "right";

/**
 * Bottom-sheet / right-drawer wrapper around Vaul.
 *
 * Deep-link aware: the caller passes `open` computed from `searchParams.sheet === id`,
 * and `onClose` typically calls `router.push(buildCloseSheetUrl(...))`.
 *
 * On mobile (< md breakpoint) Vaul defaults to a bottom sheet.
 * On desktop (md+) the drawer slides from the right and is width-constrained.
 *
 * SSR-friendly: no `typeof window` checks — `open` is a controlled prop.
 *
 * Accessibility:
 *  - `title` renders as a visually styled heading + Drawer.Title (screen reader).
 *  - Close button has aria-label="Cerrar".
 *  - B-9: optional `triggerRef` — when provided, focus returns to that element on close
 *    (mirrors ConfirmDialog.tsx pattern). Callers that don't pass it keep working as before.
 */

export type SheetProps = {
  id: string;
  title: string;
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  size?: import("@/lib/ui/sheet-helpers").SheetSize;
  /**
   * B-9: Ref to the element that triggered the sheet.
   * When provided, focus returns to it after the sheet closes.
   * Backward-compatible — callers that omit it keep existing behavior.
   */
  triggerRef?: RefObject<HTMLElement | null>;
  /**
   * Accessible description for the sheet, wired to the underlying Radix
   * DialogContent's aria-describedby via Drawer.Description. Radix warns
   * ("Missing Description for DialogContent") when a dialog renders without
   * one; supplying it also gives screen-reader users context beyond the title.
   * Falls back to the title when omitted so the warning never fires.
   */
  description?: string;
  children: ReactNode;
};

export function Sheet({
  id,
  title,
  open,
  onClose,
  size = "md",
  triggerRef,
  description,
  children,
}: SheetProps) {
  const widthClass = getDrawerWidth(size);

  // B-9: Return focus to the trigger element when the sheet closes.
  useEffect(() => {
    if (!open && triggerRef?.current) {
      triggerRef.current.focus();
    }
  }, [open, triggerRef]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      // On mobile Vaul defaults to bottom; on md+ we use right via CSS
      direction="right"
    >
      <Drawer.Portal>
        {/* Overlay */}
        <Drawer.Overlay className="fixed inset-0 z-[var(--z-drawer)] bg-black/40" />

        {/* Content */}
        {/* No explicit aria-labelledby here — Radix's DialogPrimitive.Content
            (which vaul's Content wraps) already wires aria-labelledby to its
            own internally-generated titleId and expects Drawer.Title (=
            DialogPrimitive.Title) to render with that same id. Overriding
            either side with a custom id used to break Radix's own title
            presence check (it looks up its internal titleId via
            document.getElementById, which never matched our custom id),
            producing a false "DialogContent requires a DialogTitle" warning
            even though the sheet always renders a visible title. */}
        <Drawer.Content
          data-sheet-id={id}
          className={[
            "fixed bottom-0 right-0 z-[var(--z-sheet)] flex flex-col",
            "h-[85dvh] w-full",
            // Desktop: right-drawer constrained width, full height
            `md:top-0 md:h-full ${widthClass}`,
            "bg-ln-card shadow-xl outline-none",
            "rounded-t-2xl md:rounded-none md:rounded-l-2xl",
          ].join(" ")}
        >
          {/* Drag handle — mobile only */}
          <div className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-ln-line md:hidden" />

          {/* Screen-reader description — satisfies Radix's aria-describedby
              presence check (silences the "Missing Description" warning) and
              gives assistive tech context. Visually hidden; the visible title
              above carries the on-screen heading. */}
          <Drawer.Description className="sr-only">{description ?? title}</Drawer.Description>

          {/* Header */}
          <div className="flex items-center justify-between border-b border-ln-line px-5 py-4">
            <Drawer.Title className="text-base font-semibold text-ln-ink">{title}</Drawer.Title>
            <Drawer.Close
              aria-label="Cerrar"
              className="flex h-11 w-11 items-center justify-center rounded-full text-ln-ink-2 transition-colors hover:bg-ln-stripe hover:text-ln-ink active:bg-ln-line"
            >
              <Icon name="close" size="sm" decorative />
            </Drawer.Close>
          </div>

          {/* Body — scrollable. pb-safe keeps the last row clear of the iOS
              home indicator when the bottom sheet sits at the viewport edge. */}
          <div className="pb-safe flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
