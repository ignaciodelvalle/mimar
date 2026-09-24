// @vitest-environment jsdom
//
// PresetPanel — the F3 curated-preset radiogroup. These tests pin the keyboard
// contract after the adversarial-review fix (WARNING 8): arrow keys move FOCUS
// only (roving tabindex) and NEVER commit a preset switch; selection commits on
// Enter/Space or a click. Selection-does-not-follow-focus is an accepted APG
// radiogroup variant and stops each arrow keypress from firing a fetch burst.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanoramaPreset } from "@/src/modules/panorama/domain/presets";
import { PresetPanel } from "./PresetPanel";

// Minimal two-preset fixture — only the fields PresetPanel reads (id + label)
// matter; the rest satisfy the type.
const PRESETS = [
  {
    id: "brotes-activos",
    label: "Señales de brote",
    description: "d",
    base: "cobertura",
    level: "province",
    periodPreset: "90d",
    metrics: [],
  },
  {
    id: "cumplimiento",
    label: "Cumplimiento antirrábico",
    description: "d",
    base: "cobertura",
    level: "province",
    periodPreset: "30d",
    metrics: [],
  },
] as unknown as PanoramaPreset[];

afterEach(cleanup);

describe("PresetPanel — roving focus, commit on Enter/Space (WARNING 8)", () => {
  it("arrow keys move focus WITHOUT committing a preset switch", () => {
    const onPreset = vi.fn();
    render(<PresetPanel presets={PRESETS} activePresetId="brotes-activos" onPreset={onPreset} />);

    const first = screen.getByRole("radio", { name: "Señales de brote" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    // Focus moved to the second radio; onPreset was NOT called (no commit).
    expect(screen.getByRole("radio", { name: "Cumplimiento antirrábico" })).toHaveFocus();
    expect(onPreset).not.toHaveBeenCalled();
  });

  it("Enter and Space commit the focused preset", () => {
    const onPreset = vi.fn();
    render(<PresetPanel presets={PRESETS} activePresetId="brotes-activos" onPreset={onPreset} />);

    const first = screen.getByRole("radio", { name: "Señales de brote" });
    first.focus();
    // Arrow to the second, then commit it with Enter.
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = screen.getByRole("radio", { name: "Cumplimiento antirrábico" });
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onPreset).toHaveBeenLastCalledWith("cumplimiento");

    fireEvent.keyDown(second, { key: " " });
    expect(onPreset).toHaveBeenLastCalledWith("cumplimiento");
    expect(onPreset).toHaveBeenCalledTimes(2);
  });

  it("A11Y A4 (WCAG 1.3.1): the <li> wrappers are role=presentation so radiogroup doesn't orphan listitems", () => {
    const onPreset = vi.fn();
    const { container } = render(
      <PresetPanel presets={PRESETS} activePresetId="brotes-activos" onPreset={onPreset} />,
    );
    // The <ul> carries role=radiogroup; each <li> must drop its implicit
    // listitem role (no list ancestor → axe "listitem" orphan) via presentation.
    const items = container.querySelectorAll("li");
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) expect(li).toHaveAttribute("role", "presentation");
    // No listitem role survives.
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("a click commits immediately", () => {
    const onPreset = vi.fn();
    render(<PresetPanel presets={PRESETS} activePresetId="brotes-activos" onPreset={onPreset} />);

    fireEvent.click(screen.getByRole("radio", { name: "Cumplimiento antirrábico" }));
    expect(onPreset).toHaveBeenCalledWith("cumplimiento");
  });

  it("marks only the active preset aria-checked", () => {
    const onPreset = vi.fn();
    render(<PresetPanel presets={PRESETS} activePresetId="cumplimiento" onPreset={onPreset} />);

    expect(screen.getByRole("radio", { name: "Señales de brote" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("radio", { name: "Cumplimiento antirrábico" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
