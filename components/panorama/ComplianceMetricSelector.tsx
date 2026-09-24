"use client";

// ComplianceMetricSelector — the D1 metric selector of the merged
// "Cumplimiento" vista.
//
// The five compliance-family vistas (antirrábica, esterilización, registro PPP,
// microchip, desparasitación) collapsed into ONE preset; this radiogroup picks
// WHICH metric the vista paints. Selecting an option keeps the active preset id
// (derivePreset also matches option layer sets) and swaps base + metrics + URL
// `layers=` through the SAME applyPreset path a preset click uses.
//
// Same WAI-ARIA radiogroup pattern as PresetPanel `layout="list"` (mutually
// exclusive options, roving tabindex, selection commits on click/Enter/Space —
// arrows move focus without committing).

import { useRef, useState } from "react";

import type {
  ComplianceMetricId,
  ComplianceMetricOption,
} from "@/src/modules/panorama/domain/presets";

type Props = {
  options: readonly ComplianceMetricOption[];
  /** The currently active metric (derived from the active layer set). */
  activeMetric: ComplianceMetricId;
  /** Called when the operator selects a metric option. */
  onSelect: (metric: ComplianceMetricId) => void;
};

export function ComplianceMetricSelector({ options, activeMetric, onSelect }: Props) {
  const activeIndex = options.findIndex((o) => o.metric === activeMetric);
  const selectedIndex = activeIndex >= 0 ? activeIndex : 0;
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const rovingIndex = focusIndex ?? selectedIndex;
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAt(index: number) {
    const clamped = (index + options.length) % options.length;
    setFocusIndex(clamped);
    btnRefs.current[clamped]?.focus();
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
        focusAt(options.length - 1);
        break;
      case " ":
      case "Enter": {
        e.preventDefault();
        const target = options[index];
        if (target) onSelect(target.metric);
        break;
      }
      default:
        break;
    }
  }

  return (
    <div className="space-y-1.5">
      <p
        id="panorama-metrica-label"
        className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute"
      >
        Métrica
      </p>
      <ul
        className="space-y-0.5"
        role="radiogroup"
        aria-labelledby="panorama-metrica-label"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null);
        }}
      >
        {options.map((option, index) => {
          const isActive = option.metric === activeMetric;
          return (
            // role="presentation": the <ul> carries role="radiogroup", so the
            // <li>'s implicit "listitem" role would be orphaned (same axe rule
            // PresetPanel documents); the radio semantics live on the button.
            <li key={option.metric} role="presentation">
              <button
                ref={(el) => {
                  btnRefs.current[index] = el;
                }}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: same accepted div/button radiogroup pattern as PresetPanel — a native radio input can't carry the menu-row visual without a hidden-input rework.
                role="radio"
                aria-checked={isActive}
                tabIndex={index === rovingIndex ? 0 : -1}
                title={option.label}
                onClick={() => onSelect(option.metric)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                className={`flex min-h-11 w-full items-center rounded-[var(--radius-md)] px-2.5 py-1.5 text-left transition-colors ${
                  isActive
                    ? "bg-ln-op-azul/10 font-semibold text-ln-op-azul"
                    : "text-ln-op-ink hover:bg-ln-op-stripe"
                }`}
              >
                <span className="block text-sm font-medium leading-tight">{option.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
