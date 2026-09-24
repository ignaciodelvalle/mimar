// @vitest-environment jsdom
//
// Interaction test for <FinderInPossessionForm>'s availability pair.
//
// Its sibling (finder-in-possession-form.test.tsx) renders to a STRING with
// useState stubbed, which is exactly why the defect below survived it: the bug
// only exists across a state transition. "¿Hasta cuándo podés cuidarla?" hides
// the date/time block behind `!canKeepIndefinite`, so ticking the checkbox
// UNMOUNTS DateInputAr/TimeInputAr — and a remount hands them fresh, empty
// internal state. The two halves the hidden `canKeepUntil` is composed from
// live in the PARENT, though, and used to survive the toggle: after
// tick → untick the finder saw two blank fields while the form still carried
// the old datetime, invisibly. The owner would be told "puedo cuidarla hasta"
// a moment the finder had already retracted.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(public)/p/[publicToken]/encontre/action", () => ({
  reportFinderInPossessionAction: vi.fn(async () => ({ ok: false, error: null })),
}));

vi.mock("@/app/actions/auth", () => ({
  logoutAndReturnAction: vi.fn(async () => {}),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, className }, children),
}));

// LocationFields pulls a dynamic map import — irrelevant to this contract.
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import { FinderInPossessionForm } from "@/app/(public)/p/[publicToken]/encontre/FinderInPossessionForm";

const BASE_PROPS = {
  publicToken: "DIM-P0E-001",
  petName: "Luna",
  biasProvince: "Buenos Aires",
  biasLocality: "La Plata",
};

function hiddenCanKeepUntil(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[type="hidden"][name="canKeepUntil"]');
}

function indefiniteCheckbox(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[name="canKeepIndefiniteToggle"]') as HTMLInputElement;
}

afterEach(cleanup);

describe("<FinderInPossessionForm> — canKeepUntil across the indefinite toggle", () => {
  it("composes the two halves into the datetime the action parses", () => {
    const { container } = render(<FinderInPossessionForm {...BASE_PROPS} />);

    fireEvent.change(container.querySelector("#canKeepUntilDate") as HTMLInputElement, {
      target: { value: "03072026" },
    });
    fireEvent.change(container.querySelector("#canKeepUntilTime") as HTMLInputElement, {
      target: { value: "1430" },
    });

    expect(hiddenCanKeepUntil(container)?.value).toBe("2026-07-03T14:30");
  });

  it("does not resurrect a stale datetime after tick → untick", () => {
    const { container } = render(<FinderInPossessionForm {...BASE_PROPS} />);

    fireEvent.change(container.querySelector("#canKeepUntilDate") as HTMLInputElement, {
      target: { value: "03072026" },
    });
    fireEvent.change(container.querySelector("#canKeepUntilTime") as HTMLInputElement, {
      target: { value: "1430" },
    });
    expect(hiddenCanKeepUntil(container)?.value).toBe("2026-07-03T14:30");

    // Tick: the block (and its hidden field) leaves the form entirely.
    fireEvent.click(indefiniteCheckbox(container));
    expect(hiddenCanKeepUntil(container)).toBeNull();

    // Untick: the two visible halves come back BLANK — so the composed value
    // the action receives has to be blank too.
    fireEvent.click(indefiniteCheckbox(container));
    expect((container.querySelector("#canKeepUntilDate") as HTMLInputElement).value).toBe("");
    expect((container.querySelector("#canKeepUntilTime") as HTMLInputElement).value).toBe("");
    expect(hiddenCanKeepUntil(container)?.value).toBe("");
  });
});
