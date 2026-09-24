// @vitest-environment jsdom
//
// L3·1 of the locality plan (2026-09-08): LocalityPickerAcross WARNS its parent
// when a committed value is typed over. Before, the picker cleared its own
// `selected` silently, and a parent that mirrored the pick kept submitting it —
// on /admin/govts that meant an admin could assign a unit other than the one on
// screen. The picker is exercised through its public props only; the search
// action is injected so no server action runs.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AssignLocalityForm } from "@/app/admin/govts/_components/AssignLocalityForm";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

vi.mock("@/app/actions/localities", () => ({
  searchLocalitiesAction: vi.fn(async () => ({ results: [] })),
}));

const assignGovtLocalityAction = vi.fn(async (_input: unknown) => ({ ok: true }));
vi.mock("@/app/actions/admin-institutional", () => ({
  assignGovtLocalityAction: (input: unknown) => assignGovtLocalityAction(input),
}));

// jsdom has no matchMedia; LnInput's focus handler calls it.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PALERMO = {
  indecId: "02014010",
  localityName: "Palermo",
  localitySlug: "palermo",
  provinceCode: "AR-C",
  provinceName: "CABA",
  departmentName: "Comuna 14",
} as LocalitySearchResult;

async function pickPalermo(onSelect = vi.fn(), onDeselect = vi.fn()) {
  vi.useFakeTimers();
  const searchAction = vi.fn(async () => ({ results: [PALERMO] }));
  render(
    <LocalityPickerAcross
      id="t"
      searchAction={searchAction}
      onSelect={onSelect}
      onDeselect={onDeselect}
    />,
  );
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: "Pal" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  fireEvent.focus(input);
  fireEvent.mouseDown(screen.getByText("Palermo"));
  return { input, onSelect, onDeselect };
}

describe("LocalityPickerAcross — onDeselect (L3·1)", () => {
  it("does not fire while the user is only searching", async () => {
    const { onSelect, onDeselect } = await pickPalermo();
    expect(onSelect).toHaveBeenCalledWith(PALERMO);
    expect(onDeselect).not.toHaveBeenCalled();
  });

  it("fires ONCE when the user types over a picked locality", async () => {
    const { input, onDeselect } = await pickPalermo();
    fireEvent.change(input, { target: { value: "Palermox" } });
    expect(onDeselect).toHaveBeenCalledTimes(1);
    // Still typing: the field was already uncommitted, nothing new to say.
    fireEvent.change(input, { target: { value: "Palermoxy" } });
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });

  it("fires when the user types over an untouched edit-mode default", () => {
    const onDeselect = vi.fn();
    render(
      <LocalityPickerAcross
        id="t"
        defaultValue={{ provinceCode: "AR-C", provinceName: "CABA", localityName: "Palermo" }}
        onDeselect={onDeselect}
      />,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Palerm" } });
    expect(onDeselect).toHaveBeenCalledTimes(1);
  });

  it("does not fire for free text that was never a catalog row", () => {
    const onDeselect = vi.fn();
    render(<LocalityPickerAcross id="t" onDeselect={onDeselect} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Pa" } });
    fireEvent.change(input, { target: { value: "Pal" } });
    expect(onDeselect).not.toHaveBeenCalled();
  });
});

describe("AssignLocalityForm — a typed-over pick can no longer be assigned (L3·1)", () => {
  it("disables «Confirmar asignación» the moment the admin types over the picked locality", async () => {
    vi.useFakeTimers();
    const { searchLocalitiesAction } = await import("@/app/actions/localities");
    vi.mocked(searchLocalitiesAction).mockResolvedValue({ results: [PALERMO] });
    render(<AssignLocalityForm targetUserId="u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Asignar nueva localidad" }));

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Pal" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByText("Palermo"));
    const confirm = screen.getByRole("button", { name: "Confirmar asignación" });
    expect(confirm).toBeEnabled();

    fireEvent.change(input, { target: { value: "Recoleta" } });
    expect(confirm).toBeDisabled();
    expect(screen.queryByText("Provincia: CABA")).not.toBeInTheDocument();
  });
});
