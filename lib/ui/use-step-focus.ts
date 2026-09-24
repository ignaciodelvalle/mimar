"use client";

/**
 * Accessibility fix — class-wide wizard focus gap (2026-07 a11y audit).
 *
 * Multi-step wizards (signup, pet alta, mark-lost, denuncia, mordedura,
 * servicios, ...) advance steps via client-side state, not navigation. A
 * sighted user sees the new step render; a keyboard/screen-reader user is
 * left stranded on whatever control (usually the "Siguiente" button) they
 * last activated — sometimes that control unmounts entirely, dropping focus
 * to <body> with zero announcement of what changed.
 *
 * Contract (mirrors lib/ui/use-form-error-focus.ts's transition-detection
 * idiom): given the current step and a ref to that step's focus target
 * (a heading, or a labelled step-region/progressbar), move focus to the
 * target whenever the step CHANGES. Do NOT steal focus on initial mount —
 * only on step transitions, so a keyboard user tabbing normally into the
 * wizard isn't yanked around before they've done anything.
 *
 * Usage:
 *   const stepFocusRef = useRef<HTMLDivElement>(null);
 *   useStepFocus(currentStep, stepFocusRef);
 *   <div ref={stepFocusRef} tabIndex={-1} className="focus:outline-none">...
 *
 * The target should have `tabIndex={-1}` (focusable programmatically, not
 * via Tab) and `focus:outline-none` (no visible ring for a focus move the
 * user didn't initiate) — same convention as the existing wizard progressbar
 * in components/ui/WizardShell.tsx.
 */
import { useEffect, useRef } from "react";

export function useStepFocus<T extends HTMLElement = HTMLElement>(
  step: number | string,
  ref: React.RefObject<T | null>,
): void {
  const isFirstRender = useRef(true);
  const prevStepRef = useRef(step);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref is a stable RefObject identity (from useRef in the caller); it's intentionally omitted so the dependency array stays focused on the real trigger (step).
  useEffect(() => {
    // Skip the initial mount — only react to actual step transitions.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevStepRef.current = step;
      return;
    }

    if (prevStepRef.current !== step) {
      ref.current?.focus({ preventScroll: false });
      prevStepRef.current = step;
    }
  }, [step]);
}
