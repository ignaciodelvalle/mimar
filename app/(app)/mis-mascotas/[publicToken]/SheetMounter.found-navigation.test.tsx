// @vitest-environment jsdom
//
// The marcar-encontrada sheet must leave for the profile even when the action's
// own refresh has already swapped its form out (2026-10-06).
//
// setPetFoundAction revalidates; Next 15.5 answers a revalidating action with a
// fresh render of the current route, and the profile then passes petStatus
// "active", so SheetMounter renders PetNotLostNotice where MarkFoundConfirmation
// was. The form used to navigate from an effect on its action state
// (useActionRedirect) — an effect of a component that swap unmounts. The owner
// was left on "no figura en modo perdido, no hay nada que marcar" right after
// marking the pet found. The test lands the refresh BEFORE the action result,
// which is the order that lost the navigation.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigateAfterActionSuccess: vi.fn(),
  setPetFoundAction: vi.fn(),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: mocks.navigateAfterActionSuccess,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/src/modules/events/actions", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    setPetFoundAction: {
      bind:
        () =>
        (...args: unknown[]) =>
          mocks.setPetFoundAction(...args),
    },
  };
});

import type { EventFormState } from "@/src/modules/events/actions";
import { SheetMounter } from "./SheetMounter";

const TOKEN = "abc123";

const props = {
  petToken: TOKEN,
  petName: "Luna",
  petSex: "female",
  species: "dog",
  tier2PublicEnabledUntil: null,
  tier2PublicPermanent: false,
  markLostData: null,
  editPetData: null,
  accessPath: "owner" as const,
  chapitaData: { interested: false, requestedAt: null },
  physicalCredentialChannels: null,
  emergencyContacts: {
    preferredVetName: "",
    preferredVetPhone: "",
    emergencyContactName: "",
    emergencyContactPhone: "",
  },
  disclosurePrefs: {
    discloseFirstNameWhenLost: false,
    disclosePhoneWhenLost: false,
    discloseEmailWhenLost: false,
    discloseLastLocationWhenLost: false,
    allowFinderFormWhenLost: true,
    discloseCaretakerContactWhenLost: false,
  },
  ownerFirstName: "Martín",
  alertsOriginShelter: false,
  showCheckinOption: false,
  showPregnancyStartOption: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("marcar-encontrada — the navigation survives the refresh", () => {
  it("navigates to the action's redirectTo after the form was swapped for the not-lost notice", async () => {
    let resolveResult!: (value: EventFormState) => void;
    mocks.setPetFoundAction.mockImplementation(
      () =>
        new Promise<EventFormState>((r) => {
          resolveResult = r;
        }),
    );
    window.history.replaceState(null, "", `/mis-mascotas/${TOKEN}?sheet=marcar-encontrada`);
    const view = render(<SheetMounter {...props} petStatus="lost" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar como encontrada" }));
    });
    expect(mocks.setPetFoundAction).toHaveBeenCalledTimes(1);

    // The refresh lands first: the pet is active now, the form is gone.
    view.rerender(<SheetMounter {...props} petStatus="active" />);
    expect(screen.getByText(/no figura en modo perdido/)).toBeInTheDocument();

    await act(async () => {
      resolveResult({ error: null, ok: true, redirectTo: `/mis-mascotas/${TOKEN}` });
    });

    expect(mocks.navigateAfterActionSuccess).toHaveBeenCalledWith(`/mis-mascotas/${TOKEN}`);
  });

  it("does not navigate when the action refuses, and shows why", async () => {
    mocks.setPetFoundAction.mockResolvedValue({ error: "No pudimos marcarla." });
    window.history.replaceState(null, "", `/mis-mascotas/${TOKEN}?sheet=marcar-encontrada`);
    render(<SheetMounter {...props} petStatus="lost" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Marcar como encontrada" }));
    });

    expect(mocks.navigateAfterActionSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos marcarla.");
  });
});
