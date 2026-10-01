// @vitest-environment jsdom
//
// SheetHost interaction test — the repo's FIRST interaction-level (RTL +
// jsdom) test. Every other component test here uses renderToStaticMarkup
// because Vaul's Drawer.Portal emits nothing under SSR (no DOM to portal
// into — see SheetMounter.test.tsx / components/ui/VaulSheet.test.tsx's own
// comments). This file exists specifically to close that gap for the
// router-hot-path fix: it renders the REAL trigger (PetActionRow) next to
// the REAL sheet host (SheetMounter) in a live jsdom DOM, simulates an
// actual click, and asserts the dialog opens AND the URL updates — the
// exact click-driven path a production user exercises, which
// renderToStaticMarkup structurally cannot observe (verify-report
// WARNING-1).
//
// next/navigation is mocked to mirror the one behavior this whole
// architecture depends on: Next's App Router patches window.history.
// pushState/replaceState so useSearchParams()/usePathname() update
// reactively on a shallow (same-route) URL change — see lib/ui/sheet-nav.ts
// for the full rationale. The mock below wraps jsdom's real
// history.pushState/replaceState to notify subscribed components; jsdom's
// real popstate firing on history.back() covers the back-button case for
// free, with no extra wiring.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Set<() => void>();
function notify() {
  for (const listener of listeners) listener();
}

function usePseudoRouterSubscription() {
  const [, forceRender] = React.useState(0);
  React.useEffect(() => {
    const onChange = () => forceRender((n) => n + 1);
    listeners.add(onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      listeners.delete(onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);
}

vi.mock("next/navigation", () => ({
  usePathname: () => {
    usePseudoRouterSubscription();
    return window.location.pathname;
  },
  useSearchParams: () => {
    usePseudoRouterSubscription();
    return new URLSearchParams(window.location.search);
  },
  // Sanity net: if anything in this tree falls back to router.push/replace
  // for a sheet transition, these spies make that regression visible.
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { PetActionPanel } from "@/components/pet-profile/PetActionPanel";
import { PetActionRow } from "@/components/pet-profile/PetActionRow";
import { resolveWebPetActions } from "@/components/pet-profile/pet-action-web";
import { derivePetActions } from "@dim/contract/reference";
import { SheetMounter } from "./SheetMounter";

const baseSheetMounterProps = {
  petToken: "abc123",
  petName: "Firulais",
  petSex: "male",
  species: "dog",
  tier2PublicEnabledUntil: null,
  tier2PublicPermanent: false,
  markLostData: null,
  editPetData: { existingPet: {} as never, existingPhotoUrl: null, pppBreedList: [] },
  petStatus: "active" as const,
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

/** The titular's real acts for an active dog — the row and the panel the page mounts. */
const ACTIONS = resolveWebPetActions(
  derivePetActions({
    viewerRole: "owner",
    isTitular: true,
    petStatus: "active",
    species: "dog",
    pppDoor: false,
  }),
  { petPublicToken: "abc123", petStatus: "active" },
);

function Harness() {
  return (
    <>
      <PetActionRow actions={ACTIONS.primary} />
      <PetActionPanel groups={ACTIONS.groups} />
      <SheetMounter {...baseSheetMounterProps} />
    </>
  );
}

let originalPushState: typeof window.history.pushState;
let originalReplaceState: typeof window.history.replaceState;

beforeEach(() => {
  // Vaul checks `window.matchMedia` (Safari-toolbar workaround) whenever a
  // drawer opens — jsdom has no implementation of it.
  window.matchMedia =
    window.matchMedia ??
    ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
  globalThis.ResizeObserver =
    globalThis.ResizeObserver ??
    (class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver);

  window.history.replaceState(null, "", "/mis-mascotas/abc123");
  originalPushState = window.history.pushState.bind(window.history);
  originalReplaceState = window.history.replaceState.bind(window.history);
  // Mirrors Next's own patch: notify subscribers after a shallow URL change.
  window.history.pushState = (...args: Parameters<typeof window.history.pushState>) => {
    originalPushState(...args);
    notify();
  };
  window.history.replaceState = (...args: Parameters<typeof window.history.replaceState>) => {
    originalReplaceState(...args);
    notify();
  };
});

afterEach(() => {
  cleanup();
  window.history.pushState = originalPushState;
  window.history.replaceState = originalReplaceState;
  listeners.clear();
});

describe("PetActionRow + SheetMounter — client-driven sheet open/close (router-hot-path fix)", () => {
  // Trigger via the panel's "Chapa física" row — a `?sheet=` door like the
  // old "⋯ Más" button it replaced (owner-pet-actions moved the overflow
  // inline, below the card). Assert on the URL + the dialog's own "Cerrar"
  // button so the test stays content-agnostic across whichever sheet opens.
  it("clicking an action trigger opens the sheet and updates the URL — no router involved", () => {
    render(<Harness />);

    expect(window.location.search).toBe("");
    expect(screen.queryByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Chapa física" }));

    expect(window.location.search).toContain("sheet=chapita");
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument();
  });

  it("closing via the sheet's Cerrar button strips the URL param and stays on the profile", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("link", { name: "Chapa física" }));
    expect(window.location.search).toContain("sheet=chapita");

    // Opened via pushSheetUrl, so closing goes through history.back() —
    // jsdom (like real browsers) processes history navigation as a queued
    // task, hence the wait (mirrors the back-button test below).
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));

    await waitFor(() => {
      expect(window.location.search).not.toContain("sheet=");
    });
    expect(window.location.pathname).toBe("/mis-mascotas/abc123");
    expect(screen.queryByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();
  });

  it("the back button (a real popstate from history.back()) closes an opened sheet", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("link", { name: "Chapa física" }));
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeInTheDocument();

    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      expect(window.location.search).not.toContain("sheet=");
    });
    expect(screen.queryByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();
  });

  it("a modified click (ctrl+click, e.g. open-in-new-tab intent) is left alone — sheet stays closed", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("link", { name: "Chapa física" }), { ctrlKey: true });

    expect(window.location.search).toBe("");
    expect(screen.queryByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();
  });

  it("direct load with ?sheet= already in the URL renders the sheet open without any click", () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123?sheet=chapita");
    render(<Harness />);
    // Scope to the opened sheet container: "Chapa física" also labels the
    // action-row trigger, so a bare getByText is ambiguous once the sheet mounts.
    const sheet = document.querySelector('[data-sheet-id="chapita"]');
    expect(sheet).toBeInTheDocument();
    expect(within(sheet as HTMLElement).getAllByText("Chapa física").length).toBeGreaterThan(0);
  });
});

// owner-pet-actions (PO 2026-10-01): "⋯ Más" is gone — its rows sit inline
// below the credential. An old `?sheet=mas` link (a bookmark, a notification, an
// e2e walk) is kept as an ALIAS: it lands on those rows instead of on a sheet.
describe("?sheet=mas — an alias for the acts below the card, not a sheet", () => {
  it("opens no sheet, scrolls to the acts and strips the param", async () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123?sheet=mas");
    const scrolled = vi.fn();
    render(
      <>
        <div
          id="acciones"
          ref={(el) => {
            if (el) el.scrollIntoView = scrolled;
          }}
        />
        <SheetMounter {...baseSheetMounterProps} />
      </>,
    );
    await waitFor(() => {
      expect(window.location.search).not.toContain("sheet=");
    });
    expect(scrolled).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/mis-mascotas/abc123");
  });
});

// The edit sheet ships the pet row — insurance and condition text — so the page
// hands it no data for a viewer the form refuses, and a hand-typed URL meets
// nothing rather than a form it could not save.
describe("?sheet=editar-mascota — nothing for a viewer the form refuses", () => {
  it("renders no sheet when the page passed no edit data", () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123?sheet=editar-mascota");
    render(<SheetMounter {...baseSheetMounterProps} editPetData={null} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// owner-pet-actions: the panel's "Foto" lands on `seccion=foto`, and the form's
// Contactos section opens the emergency sheet — for the titular, whose contacts
// these are, and for nobody else.
describe("?sheet=editar-mascota — the section a link asked for, and Contactos", () => {
  const editPetData = {
    existingPet: {
      publicToken: "abc123",
      species: "dog",
      name: "Firulais",
      sex: "male",
      breed: null,
      dateOfBirth: null,
      permanentConditions: [],
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    } as never,
    existingPhotoUrl: null,
    pppBreedList: [],
  };

  it("scrolls to the requested section and links Contactos to the emergency sheet", () => {
    const original = Element.prototype.scrollIntoView;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      window.history.replaceState(
        null,
        "",
        "/mis-mascotas/abc123?sheet=editar-mascota&seccion=seguro",
      );
      render(<SheetMounter {...baseSheetMounterProps} editPetData={editPetData} />);
      const dialog = screen.getByRole("dialog");
      const seguro = dialog.querySelector("#seccion-seguro");
      expect(seguro).not.toBeNull();
      expect(scrolled.mock.contexts).toContain(seguro);
      const contactos = dialog.querySelector("#seccion-contactos") as HTMLElement;
      expect(within(contactos).getByRole("link")).toHaveAttribute(
        "href",
        "/mis-mascotas/abc123?sheet=emergencia",
      );
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("gives Contactos no link when the viewer is not the titular", () => {
    window.history.replaceState(null, "", "/mis-mascotas/abc123?sheet=editar-mascota");
    render(
      <SheetMounter
        {...baseSheetMounterProps}
        editPetData={editPetData}
        emergencyContacts={null}
      />,
    );
    const contactos = screen.getByRole("dialog").querySelector("#seccion-contactos") as HTMLElement;
    expect(within(contactos).queryByRole("link")).toBeNull();
  });
});

// T1-L14 — the mark-found sheet said "Marcar como encontrada" to every animal.
// The expected words are written out here, not taken from foundParticiple, so
// a regression in the helper cannot agree with itself.
describe("marcar-encontrada sheet — agrees with the pet's sex", () => {
  for (const [petSex, word] of [
    ["male", "encontrado"],
    ["female", "encontrada"],
  ] as const) {
    it(`titles the sheet and its commit button "Marcar como ${word}" for a ${petSex} pet`, () => {
      window.history.replaceState(null, "", "/mis-mascotas/abc123?sheet=marcar-encontrada");
      render(<SheetMounter {...baseSheetMounterProps} petSex={petSex} petStatus="lost" />);

      const sheet = document.querySelector('[data-sheet-id="marcar-encontrada"]') as HTMLElement;
      expect(sheet).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: `Marcar como ${word}` })).toBeInTheDocument();
      expect(
        within(sheet).getByRole("button", { name: `Marcar como ${word}` }),
      ).toBeInTheDocument();
    });
  }
});
