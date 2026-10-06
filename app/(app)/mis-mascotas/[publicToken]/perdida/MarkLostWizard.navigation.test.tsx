// @vitest-environment jsdom
//
// A successful mark-lost must reach the confirmation even when the page that
// mounted the wizard has already replaced it (2026-10-06).
//
// setPetLostAction revalidates, and Next 15.5 answers a revalidating action
// with a fresh render of the CURRENT route. Both hosts of this wizard branch on
// the status the action just changed (`/perdida` → UpdateLastSeenForm, the
// profile's sheet → MarkLostNotApplicableNotice), so by the time the result
// reaches the wizard it can be unmounted. The old wizard set a `submitted` flag
// there and drew the success screen in place — on an unmounted component, i.e.
// nowhere. The test reproduces that order: the action resolves only AFTER the
// wizard is unmounted, and the navigation to the confirmation route must still
// fire. Against the old code it fails: nothing navigates.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigateAfterActionSuccess = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ui/full-page-action-nav", () => ({ navigateAfterActionSuccess }));
vi.mock("@/components/LocationFields", () => ({
  LocationFields: () => React.createElement("div", { "data-testid": "location-fields" }),
}));

import type { EventFormState } from "@/src/modules/events/actions";
import { MarkLostWizard } from "./MarkLostWizard";

const TOKEN = "DIM-LOST-0001";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function renderWizard(action: (prev: EventFormState, fd: FormData) => Promise<EventFormState>) {
  return render(
    <MarkLostWizard
      action={action}
      petName="Luna"
      petSex="female"
      petPublicToken={TOKEN}
      petHasMicrochip
      petHasTattoo={false}
      petColor={null}
      petDistinguishingFeatures={null}
      petJurisdictionProvince={null}
      petJurisdictionLocality={null}
    />,
  );
}

/** Chip pet → two steps: location, then the disclosure step with the submit. */
function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Continuar →" }));
  fireEvent.click(screen.getByRole("button", { name: /^Marcar como perdid/ }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MarkLostWizard — success is a navigation, not state", () => {
  it("navigates to the confirmation route even when the refresh unmounted it first", async () => {
    const result = deferred<EventFormState>();
    const action = vi.fn(() => result.promise);
    const view = renderWizard(action);

    submit();
    expect(action).toHaveBeenCalledTimes(1);
    expect((action.mock.calls[0] as unknown[])[1]).toBeInstanceOf(FormData);

    // The revalidation's re-render lands first and takes the wizard away…
    view.unmount();
    // …then the action's result arrives.
    await act(async () => {
      result.resolve({ error: null, ok: true });
      await result.promise;
    });

    expect(navigateAfterActionSuccess).toHaveBeenCalledWith(
      `/mis-mascotas/${TOKEN}/perdida/activada`,
    );
  });

  it("does not draw a confirmation in place", async () => {
    renderWizard(vi.fn(async () => ({ error: null, ok: true })));
    submit();
    await act(async () => {});
    expect(navigateAfterActionSuccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Activamos la búsqueda/)).not.toBeInTheDocument();
  });

  it("stays on the form, with the error, when the action refuses", async () => {
    renderWizard(vi.fn(async () => ({ error: "Esta mascota ya está perdida." })));
    submit();
    await act(async () => {});
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Esta mascota ya está perdida.");
  });
});
