"use client";

// PresetPanel — renders the F3 curated preset buttons.
//
// The presets are MUTUALLY EXCLUSIVE (exactly one active at a time), so the
// list is a `role="radiogroup"` of `role="radio"` buttons — not a set of
// independently-toggleable `aria-pressed` buttons (PO copy review: a screen
// reader announcing "toggle button, pressed" on each of 6 buttons never
// conveys the single-choice semantics; "radio button 2 of 6, selected" does).
// Roving tabindex per the WAI-ARIA radiogroup pattern: only the active (or
// first, when none is active) radio is tab-stoppable; arrow keys move FOCUS
// between siblings WITHOUT committing — selection commits on Enter/Space (or a
// click). The APG documents this "selection does NOT follow focus" variant as
// an accepted alternative; it stops each arrow keypress from firing a full
// preset switch (a fresh fetch burst) while the operator is merely browsing.
//
// Each preset shows ONLY its label (PO screenshot fix, 2026-07-08, engram
// obs 1047 — the description/question line was dropped from the card; the
// field stays on PanoramaPreset for other consumers, e.g. PanoramaConsole's
// metricIds). Clicking/selecting a radio calls onPreset(id) and the parent
// (PanoramaConsole) activates the corresponding compatibility-valid layer set.

import { useRef, useState } from "react";

import type { PanoramaPreset, PresetId } from "@/src/modules/panorama/domain/presets";

type Props = {
  presets: readonly PanoramaPreset[];
  /** The currently active preset id, or null/undefined when none is active
   * (e.g. the operator switched to manual "modo avanzado"). */
  activePresetId?: PresetId | null;
  /** Called when the operator clicks a preset button. */
  onPreset: (id: PresetId) => void;
  /**
   * Layout mode. "strip" (default) is the ARCHETYPE situation-room control: a
   * single-line SEGMENTED strip — one row of compact tabs, space ∝ frequency,
   * the presets stay first-class and visible (presets-as-onboarding) without
   * the six ~90px cards that used to push the map below the fold. "stack" keeps
   * the original vertical card list for any narrow side-column usage. "list"
   * (v2C) is a compact vertical menu — one slim row per preset — for the Vista
   * dropdown panel of the overlay cluster. Purely presentational — the
   * radiogroup semantics and roving focus are identical in all three.
   */
  layout?: "stack" | "strip" | "list";
  /**
   * Optional inline label id to associate this radiogroup with a label the
   * PARENT renders (e.g. the "Vista" caption sitting beside the strip in the
   * toolbar). When omitted, PresetPanel renders its own "Vista" label above.
   */
  labelledBy?: string;
};

export function PresetPanel({
  presets,
  activePresetId,
  onPreset,
  layout = "strip",
  labelledBy,
}: Props) {
  const strip = layout === "strip";
  const menuList = layout === "list";
  // Segmented strip: one bordered track holding equal-width single-line tabs.
  // Below lg it scrolls horizontally (touch), keeping the map visible; from lg
  // the tabs share the track width. "stack" keeps the original vertical cards;
  // "list" is the compact vertical menu of the v2C Vista dropdown.
  const listClass = strip
    ? "flex gap-0.5 overflow-x-auto rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-0.5 lg:overflow-visible"
    : menuList
      ? "space-y-0.5"
      : "space-y-1";
  const itemClass = strip ? "min-w-[7.5rem] shrink-0 lg:min-w-0 lg:flex-1 lg:shrink" : undefined;
  // A single touch-friendly line (~36px) in strip mode; the full card in stack;
  // a slim menu row in list.
  const cardSize = strip
    ? "min-h-[2.25rem] px-3 py-1.5"
    : menuList
      ? "min-h-11 px-2.5 py-1.5"
      : "min-h-24 px-3 py-4";

  // Roving tabindex (WAI-ARIA radiogroup pattern): the active preset is the
  // tab stop; when none is active (manual "modo avanzado"), the first one is.
  // While the operator arrows through the group, the tab stop follows FOCUS
  // (focusIndex), not selection — reset to null so a fresh Tab-in lands on the
  // selected radio again.
  const activeIndex = presets.findIndex((p) => p.id === activePresetId);
  const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rovingIndex = focusIndex ?? selectedIndex;
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAt(index: number) {
    const clamped = (index + presets.length) % presets.length;
    setFocusIndex(clamped);
    btnRefs.current[clamped]?.focus();
  }

  function commitAt(index: number) {
    const target = presets[index];
    if (target) onPreset(target.id);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        focusAt(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        focusAt(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(presets.length - 1);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        commitAt(index);
        break;
      default:
        break;
    }
  }

  // In strip mode the bordered track carries the frame; each tab is borderless
  // and the active one fills. In stack mode each preset keeps its own card border.
  const buttonBase = strip
    ? "flex w-full items-center justify-center rounded-[calc(var(--radius-md)-2px)] text-center transition-colors"
    : menuList
      ? "flex w-full items-center rounded-[var(--radius-md)] text-left transition-colors"
      : "flex w-full flex-col items-start justify-center rounded-[var(--radius-md)] border text-left transition-colors";
  const activeClass = strip
    ? "bg-ln-op-azul/15 text-ln-op-azul"
    : menuList
      ? "bg-ln-op-azul/10 font-semibold text-ln-op-azul"
      : "border-ln-op-azul bg-ln-op-azul/10 text-ln-op-azul";
  const idleClass = strip
    ? "text-ln-op-ink-2 hover:bg-ln-op-stripe"
    : menuList
      ? "text-ln-op-ink hover:bg-ln-op-stripe"
      : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:border-ln-op-azul/40 hover:bg-ln-op-card";

  // The blur handler only resets the roving tab stop (focus bookkeeping); the
  // radios carry all interactive semantics. Focus left the whole group → drop
  // the roving position so a later Tab-in lands on the SELECTED radio (APG).
  const list = (
    <ul
      className={listClass}
      role="radiogroup"
      aria-labelledby={labelledBy ?? "panorama-vista-label"}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
      }}
    >
      {presets.map((preset, index) => {
        const isActive = activePresetId === preset.id;
        return (
          // role="presentation": the parent <ul> carries role="radiogroup", so
          // the <li>'s implicit "listitem" role has no list ancestor and axe
          // flags it as orphaned (WCAG 1.3.1). The radio semantics live on the
          // inner button; the <li> is pure layout here.
          <li key={preset.id} role="presentation" className={itemClass}>
            <button
              ref={(el) => {
                btnRefs.current[index] = el;
              }}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: a native <input type="radio"> can't carry this tab's Tailwind visual (segmented fill / card stack) without a hidden-input + styled-label rework — the WAI-ARIA APG explicitly documents this div/button radiogroup pattern as an accepted alternative.
              role="radio"
              aria-checked={isActive}
              tabIndex={index === rovingIndex ? 0 : -1}
              title={preset.label}
              onClick={() => onPreset(preset.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`${buttonBase} ${cardSize} ${isActive ? activeClass : idleClass}`}
            >
              <span
                className={`block text-sm font-medium leading-tight ${strip ? "truncate" : ""}`}
              >
                {preset.label}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  // When the parent supplies the label (toolbar placement) render just the
  // strip; otherwise keep the self-labeled block for standalone use.
  if (labelledBy) return list;
  return (
    <div className="space-y-1.5">
      <p
        id="panorama-vista-label"
        className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute"
      >
        Vista
      </p>
      {list}
    </div>
  );
}
