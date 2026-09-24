// @vitest-environment jsdom
//
// T4.6 (2026-08-01): the drawer's own doc comment (§ACCESSIBILITY, top of
// DetailDrawer.tsx) has always claimed "the backdrop is also a close
// target" — but no handler ever implemented it. showModal() renders
// everything outside the sliding panel inert to focus/interaction, yet a
// click on that dimmed area was a dead click: the drawer just sat there.
//
// jsdom doesn't implement native <dialog>.showModal/close — stub them (same
// pattern as components/ui/ConfirmDialog.test.tsx) so the drawer renders
// open without throwing.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DetailDrawer, type SelectedFeature } from "@/components/panorama/DetailDrawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/panorama",
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(cleanup);

// "refugios" is a reference layer (REFERENCE_LAYER_IDS) — shouldFetchHistory
// is false for it, so the drawer renders with no unit-history fetch to mock.
const SELECTED: SelectedFeature = {
  layerId: "refugios",
  layerLabel: "Refugios",
  properties: { name: "Refugio Esperanza", verified: true },
};

describe("DetailDrawer — backdrop click closes the drawer (T4.6)", () => {
  it("calls onClose when press AND release land on the dialog itself (the backdrop)", () => {
    const onClose = vi.fn();
    render(<DetailDrawer selected={SELECTED} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { hidden: true });
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when the click lands inside the panel content", () => {
    const onClose = vi.fn();
    render(<DetailDrawer selected={SELECTED} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("Refugio Esperanza"));
    fireEvent.click(screen.getByText("Refugio Esperanza"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does NOT close on a text-selection drag that starts inside and releases over the backdrop", () => {
    // UI Events: when mousedown and mouseup hit different elements, `click`
    // fires on their nearest common ancestor — here, the <dialog> itself.
    // Closing there would destroy the operator's selection (review 2026-08-01).
    const onClose = vi.fn();
    render(<DetailDrawer selected={SELECTED} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { hidden: true });
    fireEvent.pointerDown(screen.getByText("Refugio Esperanza"));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does NOT call onClose for the explicit close button's own click (still wired, not double-fired)", () => {
    const onClose = vi.fn();
    render(<DetailDrawer selected={SELECTED} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    // The close button click bubbles to the dialog, but its target is the
    // button, not the dialog — the guard must not fire twice for one click.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
