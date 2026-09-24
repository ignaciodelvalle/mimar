// @vitest-environment jsdom
//
// EmergencyContactSheet — post-mutation staleness fix (QA finding 5b, engram
// #635). Saving successfully closed the sheet, but CredentialFace's
// EmergencyCard (a Server Component rendered by page.tsx) kept showing the
// OLD phone until a hard reload: the server action's revalidatePath() only
// marks the RSC cache stale, and this profile's shallow-routing architecture
// (lib/ui/sheet-nav.ts, adopted to route around the router-drop defect —
// engram #621/#622) never issues a follow-up RSC fetch that would pick that
// up.
//
// Fix: onSaved now closes via closeSheetNavWithFullReload (a real
// window.location.assign navigation) instead of the regular shallow
// closeSheetNav (history.replaceState/back). This test renders SheetMounter
// with `?sheet=emergencia` already open, submits the form, and asserts the
// close path taken is the full-navigation one — never the shallow one, and
// never a bare router.refresh()-style call (this app doesn't have one, but
// the point is nothing here relies on the client router at all).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updateEmergencyContactsAction = vi.fn();

vi.mock("@/app/actions/profile", () => ({
  updateEmergencyContactsAction: (...args: unknown[]) => updateEmergencyContactsAction(...args),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/mis-mascotas/abc123",
  useSearchParams: () => new URLSearchParams("sheet=emergencia"),
}));

import { SheetMounter } from "../SheetMounter";

const baseSheetMounterProps = {
  petToken: "abc123",
  petName: "Firulais",
  petSex: "male",
  species: "dog",
  tier2PublicEnabledUntil: null,
  tier2PublicPermanent: false,
  markLostData: null,
  physicalCredentialChannels: null,
  editPetData: { existingPet: {} as never, existingPhotoUrl: null, pppBreedList: [] },
  petStatus: "active" as const,
  accessPath: "owner" as const,
  ownershipRole: "owner" as const,
  hasPendingReturnProposal: false,
  chapitaData: { interested: false, requestedAt: null },
  emergencyContacts: {
    preferredVetName: "",
    preferredVetPhone: "",
    emergencyContactName: "",
    emergencyContactPhone: "+54 9 11 0000-0000",
  },
  disclosurePrefs: {
    discloseFirstNameWhenLost: true,
    disclosePhoneWhenLost: true,
    discloseEmailWhenLost: false,
    discloseLastLocationWhenLost: true,
    allowFinderFormWhenLost: true,
    discloseCaretakerContactWhenLost: false,
  },
  ownerFirstName: "Martín",
  alertsOriginShelter: false,
  showCheckinOption: false,
  showPregnancyStartOption: false,
};

const mockAssign = vi.fn();
const originalLocation = window.location;
const originalReplaceState = window.history.replaceState.bind(window.history);
const originalBack = window.history.back.bind(window.history);

beforeEach(() => {
  updateEmergencyContactsAction.mockReset();
  mockAssign.mockClear();
  window.history.replaceState = vi.fn();
  window.history.back = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign: mockAssign },
  });
});

afterEach(() => {
  cleanup();
  window.history.replaceState = originalReplaceState;
  window.history.back = originalBack;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("EmergencyContactSheet — full-reload close on save (post-mutation staleness fix)", () => {
  it("saving successfully closes via window.location.assign, stripping only ?sheet=", async () => {
    updateEmergencyContactsAction.mockResolvedValue({ ok: true });
    render(<SheetMounter {...baseSheetMounterProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(mockAssign).toHaveBeenCalledTimes(1);
    });
    expect(mockAssign).toHaveBeenCalledWith("/mis-mascotas/abc123");
    // Never the shallow history-API close — that's the exact path that left
    // the stale EmergencyCard on screen.
    expect(window.history.replaceState).not.toHaveBeenCalled();
    expect(window.history.back).not.toHaveBeenCalled();
  });

  it("a failed save does NOT close the sheet (no navigation at all)", async () => {
    updateEmergencyContactsAction.mockResolvedValue({ error: "No se pudo guardar." });
    render(<SheetMounter {...baseSheetMounterProps} />);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(screen.getByText("No se pudo guardar.")).toBeInTheDocument();
    });
    expect(mockAssign).not.toHaveBeenCalled();
    expect(window.history.replaceState).not.toHaveBeenCalled();
  });
});
