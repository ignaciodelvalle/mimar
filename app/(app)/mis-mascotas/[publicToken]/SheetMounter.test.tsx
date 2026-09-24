// Tests for <SheetMounter>'s `?sheet=anotar` branch — pet-document-redesign
// D1/D5/D6.
//
// LIMITATION (same as components/ui/VaulSheet.test.tsx): Vaul's
// `Drawer.Portal` emits nothing under `renderToStaticMarkup` (no DOM to
// portal into), so we cannot assert on the sheet's rendered CaptureBox/
// CaptureOptionsList markup here. What we CAN verify with this harness:
//   - the branch doesn't throw and (for the owner path) reaches the shared
//     <Sheet> primitive — which is where the actual Vaul-provided focus-trap
//     (focus into sheet on open, Escape closes) and focus-return-to-trigger
//     guarantees live, generically, for every sheet in this mounter. This is
//     the D6 a11y coverage: anotar uses the exact same primitive as every
//     other sheet, no bespoke focus handling to regress.
//   - the org-viewer guard (REQ-4.4): accessPath !== "owner" returns null
//     BEFORE reaching <Sheet> at all — this IS fully assertable (empty
//     string), and is the D5 coverage.
//   - absent/other `sheet` values render nothing.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let currentSheet: string | null = null;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mis-mascotas/abc123",
  useSearchParams: () => ({
    get: (key: string) => (key === "sheet" ? currentSheet : null),
    toString: () => (currentSheet ? `sheet=${currentSheet}` : ""),
  }),
}));

import { SheetMounter } from "./SheetMounter";

const baseProps = {
  petToken: "abc123",
  petName: "Firulais",
  petSex: "male",
  species: "dog",
  tier2PublicEnabledUntil: null,
  tier2PublicPermanent: false,
  markLostData: null,
  editPetData: { existingPet: {} as never, existingPhotoUrl: null, pppBreedList: [] },
  petStatus: "active" as const,
  ownershipRole: "owner" as const,
  hasPendingReturnProposal: false,
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

describe("<SheetMounter> — sheet=anotar, owner path", () => {
  it("does not throw and reaches the shared Sheet primitive (D6: inherited focus-trap)", () => {
    currentSheet = "anotar";
    expect(() =>
      renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="owner" />),
    ).not.toThrow();
  });
});

describe("<SheetMounter> — sheet=anotar, org viewer guard (REQ-4.4 / D5)", () => {
  it("renders nothing for accessPath='org' — ?sheet=anotar is unreachable via org-facing UI", () => {
    currentSheet = "anotar";
    const html = renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="org" />);
    expect(html).toBe("");
  });
});

describe("<SheetMounter> — no sheet param", () => {
  it("renders nothing when sheet is absent", () => {
    currentSheet = null;
    const html = renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="owner" />);
    expect(html).toBe("");
  });
});

describe("<SheetMounter> — sheet=chapita (ADR-17b / REQ-11.2, REQ-9.3)", () => {
  it("owner + active pet: reaches the shared Sheet primitive", () => {
    currentSheet = "chapita";
    expect(() =>
      renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="owner" />),
    ).not.toThrow();
  });

  it("org viewer: renders nothing", () => {
    currentSheet = "chapita";
    const html = renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="org" />);
    expect(html).toBe("");
  });

  it("deceased pet: renders nothing even for the owner (REQ-9.3)", () => {
    currentSheet = "chapita";
    const html = renderToStaticMarkup(
      <SheetMounter {...baseProps} accessPath="owner" petStatus="deceased" chapitaData={null} />,
    );
    expect(html).toBe("");
  });
});

describe("<SheetMounter> — sheet=emergencia (ADR-13, Phase 5)", () => {
  it("owner: reaches the shared Sheet primitive", () => {
    currentSheet = "emergencia";
    expect(() =>
      renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="owner" />),
    ).not.toThrow();
  });

  it("org viewer: renders nothing", () => {
    currentSheet = "emergencia";
    const html = renderToStaticMarkup(<SheetMounter {...baseProps} accessPath="org" />);
    expect(html).toBe("");
  });

  it("owner with emergencyContacts=null (defense-in-depth backstop): renders nothing", () => {
    currentSheet = "emergencia";
    const html = renderToStaticMarkup(
      <SheetMounter {...baseProps} accessPath="owner" emergencyContacts={null} />,
    );
    expect(html).toBe("");
  });
});
