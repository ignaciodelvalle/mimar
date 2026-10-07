// @vitest-environment jsdom
//
// The stale banner's "marcar encontrado/a" must navigate even though the
// action's own refresh removes the banner that holds it (2026-10-06): the
// profile re-renders as found, the form is unmounted, and an effect-based
// redirect on it never ran. The unmount lands BEFORE the result here.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setPetFoundAction: vi.fn(),
  navigateAfterActionSuccess: vi.fn(),
}));

vi.mock("@/src/modules/events/actions", () => ({
  setPetFoundAction: {
    bind:
      () =>
      (...args: unknown[]) =>
        mocks.setPetFoundAction(...args),
  },
}));
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: mocks.navigateAfterActionSuccess,
}));

import { MarkFoundInlineForm } from "./MarkFoundInlineForm";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<MarkFoundInlineForm>", () => {
  it("navigates to the action's redirectTo after the refresh removed the form", async () => {
    let resolveResult!: (value: unknown) => void;
    mocks.setPetFoundAction.mockImplementation(
      () =>
        new Promise((r) => {
          resolveResult = r;
        }),
    );
    const view = render(<MarkFoundInlineForm petPublicToken="DIM-1" label="Apareció" />);
    (view.container.querySelector("form") as HTMLFormElement).requestSubmit();
    await waitFor(() => expect(mocks.setPetFoundAction).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      resolveResult({ error: null, ok: true, redirectTo: "/mis-mascotas/DIM-1" });
    });

    expect(mocks.navigateAfterActionSuccess).toHaveBeenCalledWith("/mis-mascotas/DIM-1");
  });

  it("shows the refusal and stays put", async () => {
    mocks.setPetFoundAction.mockResolvedValue({ error: "No pudimos marcarla." });
    const view = render(<MarkFoundInlineForm petPublicToken="DIM-1" label="Apareció" />);
    (view.container.querySelector("form") as HTMLFormElement).requestSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("No pudimos marcarla.");
    expect(mocks.navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});
