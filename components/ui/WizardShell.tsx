"use client";

import { useEffect, useRef } from "react";

import { useStepFocus } from "@/lib/ui/use-step-focus";

/**
 * LnWizardShell — generic multi-step wizard chrome (LN design system).
 *
 * Owns the top bar (back / step counter / optional cancel), the progress bar,
 * and the main content slot. Wizard state and step content are caller-supplied.
 */

export type LnWizardShellProps = {
  currentStep: number; // 1-indexed
  totalSteps: number;
  /** Optional per-step short label. When provided, the current step's label
   * is shown under the counter; the array length should be >= totalSteps. */
  stepLabels?: string[];
  onBack?: () => void;
  /** Optional cancel handler. When provided, a "Cancelar y volver" button is
   * rendered next to the back arrow (top right). */
  onCancel?: () => void;
  /**
   * @deprecated The AppShell already renders the `#main-content` <main> landmark
   * that wraps this wizard. Rendering a second `id="main-content"` here produced
   * a duplicate id AND a nested <main> landmark (invalid HTML + a11y violation).
   * This prop is now ignored; the wizard content is a plain <div>.
   */
  mainId?: string;
  children: React.ReactNode;
};

export function LnWizardShell({
  currentStep,
  totalSteps,
  stepLabels,
  onBack,
  onCancel,
  children,
}: LnWizardShellProps) {
  // Progress percent — (currentStep - 1) / totalSteps so step 1 renders as 0%
  // and the final step renders as (n-1)/n until submission completes.
  const progressPct = Math.round(((currentStep - 1) / totalSteps) * 100);
  const stepLabel = stepLabels?.[currentStep - 1];
  const stepFocusRef = useRef<HTMLDivElement>(null);

  // Reset scroll to the top on every step change. The AppShell's
  // `<main id="main-content">` is the overflow-auto scroll container (so a tall
  // step doesn't leave the next step scrolled past the top); window is the
  // fallback for layouts that scroll the document instead.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentStep is the intentional trigger — the effect scrolls on every step change without reading its value.
  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [currentStep]);

  // A11y fix (2026-07 audit): move focus to the progressbar below on every
  // step change. It already carries a dynamic aria-label ("Paso X de Y"), so
  // this both announces the transition to screen readers AND repositions
  // keyboard focus so the next Tab press lands inside the new step's content
  // instead of on a control that may have unmounted. Every wizard built on
  // <LnWizardShell> gets this for free — see lib/ui/use-step-focus.ts.
  useStepFocus(currentStep, stepFocusRef);

  return (
    <div className="bg-[var(--color-ln-card)] flex flex-col">
      <header className="flex items-center gap-3 px-4 pt-5 pb-3">
        {onBack && currentStep > 1 ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Paso anterior"
            className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center text-[var(--color-ln-mute)] hover:bg-[var(--color-ln-stripe)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
          >
            ←
          </button>
        ) : (
          <div className="w-11 h-11 flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          {/* A single-step wizard has nothing to count — "Paso 1 de 1" reads
              as noise (QA round 2 2026-07-03 #7), so counter + progress bar
              only render for genuinely multi-step flows. */}
          {totalSteps > 1 && (
            <p className="text-xs text-[var(--color-ln-mute)] tabular-nums">
              Paso {currentStep} de {totalSteps}
            </p>
          )}
          {stepLabel ? (
            <p className="text-sm font-medium text-[var(--color-ln-ink)] truncate">{stepLabel}</p>
          ) : null}
        </div>

        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="flex-shrink-0 text-xs text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)] underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2 rounded px-1"
          >
            Cancelar y volver
          </button>
        ) : null}
      </header>

      {totalSteps > 1 && (
        <div
          ref={stepFocusRef}
          className="h-0.5 bg-[var(--color-ln-stripe)] mx-4 rounded-full overflow-hidden focus:outline-none"
          role="progressbar"
          tabIndex={-1}
          aria-valuenow={currentStep}
          aria-valuemin={1}
          aria-valuemax={totalSteps}
          aria-label={`Paso ${currentStep} de ${totalSteps}`}
        >
          <div
            className="h-full bg-[var(--color-ln-azul)] rounded-full transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* Plain <div>, NOT <main>: the AppShell already owns the #main-content
          <main> landmark that wraps this wizard. A nested <main> + duplicate id
          was invalid HTML and tripped the a11y / skip-link checks. */}
      <div className="flex-1 px-4 pt-8 pb-32 max-w-md mx-auto w-full">{children}</div>
    </div>
  );
}
