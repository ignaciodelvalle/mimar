// @vitest-environment jsdom
//
// LostDisclosureCard — toast-sweep-2026-07-21: these 5 disclosure toggles had
// ZERO feedback of any kind (no optimistic local state, no error surface) —
// the most silent mutation found in the sweep. Pins that a toggle fires
// notifySaved on success and notifyActionError when the bound server action
// rejects (mutation-feedback convention, lib/ui/action-feedback.ts).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { LostDisclosureCard } from "./LostDisclosureCard";

const prefs = {
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: false,
  allowFinderFormWhenLost: false,
  discloseCaretakerContactWhenLost: false,
};

beforeEach(() => {
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  cleanup();
});

it("fires the success toast after a toggle resolves", async () => {
  const toggleAction = vi.fn().mockResolvedValue(undefined);
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={toggleAction}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );

  fireEvent.click(screen.getByRole("switch", { name: "Tu teléfono" }));

  await waitFor(() => {
    expect(toggleAction).toHaveBeenCalledWith("disclosePhoneWhenLost", true);
  });
  await waitFor(() => {
    expect(toastSuccess).toHaveBeenCalledWith("Preferencia actualizada");
  });
  expect(toastError).not.toHaveBeenCalled();
});

it("shows the concrete public preview on the name row when disclosure is on (QA 2026-08-03)", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );

  expect(screen.getByText('El público ve "Lo busca Nacho".')).toBeInTheDocument();
  // The old standalone footer preview line is gone.
  expect(screen.queryByText(/Hoy verán/)).not.toBeInTheDocument();
});

it("keeps the generic name-row description when disclosure is off", () => {
  render(
    <LostDisclosureCard
      prefs={{ ...prefs, discloseFirstNameWhenLost: false }}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );

  expect(screen.getByText("El público ve quién busca a la mascota.")).toBeInTheDocument();
  expect(screen.queryByText(/Lo busca Nacho/)).not.toBeInTheDocument();
});

it("fires the error toast when the bound action rejects", async () => {
  const toggleAction = vi.fn().mockRejectedValue(new Error("boom"));
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={toggleAction}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );

  fireEvent.click(screen.getByRole("switch", { name: "Tu email" }));

  await waitFor(() => {
    expect(toastError).toHaveBeenCalledWith("No se pudo guardar. Probá de nuevo.");
  });
  expect(toastSuccess).not.toHaveBeenCalled();
});

// A5 (PO decision 2026-08-04) — the origin shelter is notified when someone
// reports finding the pet. The PO chose "always", so the mitigation is
// DISCLOSURE: the titular must read it on their own pet's privacy surface, and
// must also read the LIMIT (the finder's contact is not shared).
it("discloses the origin-shelter alert when the pet came out of a shelter", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={true}
    />,
  );
  expect(screen.getByText(/salió de un refugio/i)).toBeInTheDocument();
  expect(screen.getByText(/ese refugio\s+también recibe el aviso/i)).toBeInTheDocument();
  // The limit is not optional copy — it is the reason the disclosure is enough.
  expect(screen.getByText(/no se le comparte el contacto/i)).toBeInTheDocument();
});

it("says nothing about shelters for a pet with no origin shelter", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );
  expect(screen.queryByText(/refugio/i)).toBeNull();
});

// ---------------------------------------------------------------------------
// KEY 1 OF THE TWO-KEY PUBLIC-CONTACT MODEL (PO decision 2, 2026-08-19).
//
// Publishing a caretaker's phone number on an unauthenticated page is the
// titular consenting on somebody ELSE's behalf. So it takes two keys:
//
//   key 2 — the caretaker's, captured at invitation accept
//           (`pet_caretaker_grants.public_contact_consent_at`);
//   key 1 — the titular's, this row (`pets.disclose_caretaker_contact_when_lost`,
//           migration 0193), off by default like its five siblings.
//
// THE RENDER GATE IS THE PART THAT MATTERS. Without key 2 the row must not
// appear AT ALL. A switch that cannot do anything is a lie in the shape of a
// control: the titular flips it, the page says "Preferencia actualizada", and
// the public credential shows nothing — with no way to find out why. The PO
// approved the two-key shape knowing its cost (if the caretaker declines, the
// titular simply cannot publish); hiding the row is how that cost is told.
// ---------------------------------------------------------------------------

it("does not render the caretaker row when there is no caretaker at all", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
    />,
  );
  expect(screen.queryByRole("switch", { name: /cuidador/i })).toBeNull();
});

it("does not render the caretaker row when the caretaker has NOT consented", () => {
  // Key 2 absent. This is the case the whole gate exists for.
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
      caretakerConsentName={null}
    />,
  );
  expect(screen.queryByRole("switch", { name: /cuidador/i })).toBeNull();
});

it("renders the caretaker row once BOTH keys are possible, off by default", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
      caretakerConsentName="Ana"
    />,
  );
  const row = screen.getByRole("switch", { name: /cuidador/i });
  expect(row).toBeInTheDocument();
  expect(row).toHaveAttribute("aria-checked", "false");
});

it("names the caretaker, so the titular knows WHOSE contact they are publishing", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
      caretakerConsentName="Ana"
    />,
  );
  expect(screen.getByText(/Ana/)).toBeInTheDocument();
});

it("writes the caretaker key through the same bound action as its siblings", async () => {
  const toggleAction = vi.fn().mockResolvedValue(undefined);
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={toggleAction}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
      caretakerConsentName="Ana"
    />,
  );
  fireEvent.click(screen.getByRole("switch", { name: /cuidador/i }));
  await waitFor(() =>
    expect(toggleAction).toHaveBeenCalledWith("discloseCaretakerContactWhenLost", true),
  );
});

it("leaves the five original rows untouched — this is an addition, not a redesign", () => {
  render(
    <LostDisclosureCard
      prefs={prefs}
      toggleAction={vi.fn()}
      publicHref="/p/DIM-TEST-0001"
      ownerFirstName="Nacho"
      alertsOriginShelter={false}
      caretakerConsentName="Ana"
    />,
  );
  expect(screen.getAllByRole("switch")).toHaveLength(6);
});
