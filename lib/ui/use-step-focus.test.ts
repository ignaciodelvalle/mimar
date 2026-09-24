// @vitest-environment jsdom
//
// Tests for lib/ui/use-step-focus.ts — the class-wide wizard-step focus fix.

import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { useStepFocus } from "./use-step-focus";

function setup(initialStep: number | string) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const focusSpy = vi.spyOn(el, "focus");

  const { rerender } = renderHook(
    ({ step }: { step: number | string }) => {
      const ref = useRef<HTMLDivElement>(el);
      useStepFocus(step, ref);
    },
    { initialProps: { step: initialStep } },
  );

  return { el, focusSpy, rerender };
}

describe("useStepFocus", () => {
  it("does NOT focus the target on initial mount", () => {
    const { focusSpy } = setup(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("moves focus to the target when the step changes", () => {
    const { focusSpy, rerender } = setup(1);

    rerender({ step: 2 });

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: false });
  });

  it("does not re-focus on a re-render where the step is unchanged", () => {
    const { focusSpy, rerender } = setup(1);

    rerender({ step: 1 });

    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("supports string step keys (e.g. signup's account/identity phases)", () => {
    const { focusSpy, rerender } = setup("account");

    rerender({ step: "identity" });

    expect(focusSpy).toHaveBeenCalledTimes(1);
  });

  it("focuses again on each subsequent step change", () => {
    const { focusSpy, rerender } = setup(1);

    rerender({ step: 2 });
    rerender({ step: 3 });

    expect(focusSpy).toHaveBeenCalledTimes(2);
  });
});
