"use client";

// LnCombobox — shared shell for LN autocomplete/combobox fields, extracted
// from two near-duplicate implementations (2026-07-18 hardening pass):
// LocalityPickerAcross (async, server-debounced locality search) and the
// vaccine-name field in VaccinationForm (sync, client-side substring filter
// — its keyboard layer was a documented port of LocalityPickerAcross's).
//
// Owns the interaction SHELL only:
//   - the combobox <input> (WAI-ARIA APG pattern — role="combobox",
//     aria-expanded, aria-controls, aria-autocomplete="list",
//     aria-activedescendant)
//   - the popup listbox (role="listbox" / role="option" per row)
//   - keyboard nav (ArrowUp/ArrowDown/Enter/Escape) + active-option tracking
//   - the onMouseDown-before-blur select pattern + blur-close timer
//
// Deliberately does NOT own matching. `items` arrives already filtered from
// the caller — locality search is an async server round-trip, vaccine search
// is a synchronous client-side substring filter over a static catalog. Two
// injection points keep each caller's own algorithm fully separate from the
// shell:
//   - `items` — the caller computes (and re-computes) the filtered/matched
//     list however it wants; this component just renders and navigates it.
//   - `renderItem` — the caller owns each option's markup (locality shows two
//     lines: name + department/province; vaccine shows a name + a "Núcleo"
//     core-vaccine badge). The shell supplies only `{ active, index }`.
//
// `open` is caller-controlled (not internal) because the two call sites gate
// opening differently: LocalityPickerAcross reopens on focus only when there
// are already-cached results; the vaccine field always opens on focus to
// show the full species catalog. Baking one policy into the shell would
// force it on both callers.
//
// role="option" lives on <li> (no native HTML element carries that
// semantic) — same APG pattern as components/ui/dashboard/OpOmnibox.tsx,
// which needs the identical biome a11y override (see biome.json).

import { useEffect, useId, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";

import { LnInput, type LnInputProps } from "@/components/ui/Field";

export type LnComboboxRenderState = {
  active: boolean;
  index: number;
};

type OmittedInputProps =
  | "role"
  | "aria-expanded"
  | "aria-controls"
  | "aria-autocomplete"
  | "aria-activedescendant"
  // native <input> has its own onSelect (fires on text-selection change) —
  // shadowed here by the combobox's item-pick callback of the same name.
  | "onSelect";

export type LnComboboxProps<T> = {
  /** Pre-filtered/matched results to display. The caller owns matching. */
  items: T[];
  getItemKey: (item: T) => string;
  /** Fired on pick — via mouse (onMouseDown on the option) or Enter. */
  onSelect: (item: T) => void;
  /** Render injection for each option's content; the shell supplies active/index. */
  renderItem: (item: T, state: LnComboboxRenderState) => ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Shown as the listbox's sole content when open but `items` is empty. Omit to render no popup at all in that case (the vaccine field's contract). */
  emptyState?: ReactNode;
  /** Delay before a blur closes the list, letting an onMouseDown selection register first. */
  blurCloseDelayMs?: number;
  listClassName?: string;
} & Omit<LnInputProps, OmittedInputProps>;

export function LnCombobox<T>({
  items,
  getItemKey,
  onSelect,
  renderItem,
  open,
  onOpenChange,
  emptyState,
  blurCloseDelayMs = 150,
  listClassName,
  onKeyDown,
  onBlur,
  ...inputProps
}: LnComboboxProps<T>) {
  const listboxId = useId();
  const optionBaseId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-anchor the active option to the top whenever the list opens or its
  // contents change — both call sites highlight the first result on open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open/items are the intentional triggers — the effect resets the index without reading their values (same idiom as WizardShell's step-change scroll).
  useEffect(() => {
    setActiveIndex(0);
  }, [open, items]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (!open || items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = items[activeIndex];
      if (picked) onSelect(picked);
    } else if (e.key === "Escape") {
      onOpenChange(false);
    }
  }

  function handleBlur(e: FocusEvent<HTMLInputElement>) {
    onBlur?.(e);
    if (blurTimer.current) clearTimeout(blurTimer.current);
    // Delay close so a click/tap on an option (onMouseDown) registers before
    // the list unmounts.
    blurTimer.current = setTimeout(() => onOpenChange(false), blurCloseDelayMs);
  }

  const showListbox = open && (items.length > 0 || emptyState !== undefined);
  const activeDescendant =
    showListbox && items.length > 0 ? `${optionBaseId}-${activeIndex}` : undefined;

  return (
    <div className="relative">
      <LnInput
        role="combobox"
        aria-expanded={showListbox}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendant}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        {...inputProps}
      />
      {showListbox && (
        <ul
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          className={
            listClassName ??
            "absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius-sm)] border border-ln-line bg-ln-card shadow-lg"
          }
        >
          {items.length === 0
            ? emptyState
            : items.map((item, index) => {
                const active = index === activeIndex;
                return (
                  <li
                    key={getItemKey(item)}
                    id={`${optionBaseId}-${index}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    onMouseDown={(e) => {
                      // mousedown (not click) so selection fires BEFORE the
                      // input's onBlur closes the list.
                      e.preventDefault();
                      onSelect(item);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    {renderItem(item, { active, index })}
                  </li>
                );
              })}
        </ul>
      )}
    </div>
  );
}
