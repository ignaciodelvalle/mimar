// @vitest-environment jsdom
// RA-2 F1 — the duplicate-signature guard must be REACHABLE FROM THE CARD.
//
// The defect this file exists to prevent: `rejectIfAlreadySigned` is described
// in atender-declared-events.ts as "the last line of defence for the
// duplicate-signature damage when a post-action navigation is dropped", and it
// was dead code. The declared event's id was used as a React `key` and nothing
// else, so it never entered the CTA href, so AtenderCaptureMounter always bound
// `confirmEventId = null`, so the `if (confirmEventId)` gate in the actions
// never fired. The guard's own tests passed the id straight to the action, which
// proves nothing about whether a user can ever reach it — that is exactly how
// this survived two units of work on the same surface.
//
// So this test walks the REAL chain and never hand-feeds an id:
//   PendingSignaturesCard → rendered href → query string → AtenderCaptureMounter
//   → the argument bound onto atenderMicrochipAction / atenderSterilizationAction.
// If the id stops reaching the URL, the bound argument goes null and these fail.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingDeclaredEvent } from "../atender-declared-events";

// Action doubles. `.bind` is shadowed with a spy so the bound arguments are
// observable — the mounter calls
// `action.bind(null, orgToken, publicToken, confirmEventId)`.
// Hoisted because vi.mock factories run during module import, before the rest
// of this file's top-level bindings are initialised.
const actionDoubles = vi.hoisted(() => {
  const makeBoundSpy = () => {
    const bind = vi.fn(() => async () => ({ error: null }));
    return Object.assign(() => {}, { bind });
  };
  return {
    makeBoundSpy,
    atenderMicrochipAction: makeBoundSpy(),
    atenderSterilizationAction: makeBoundSpy(),
  };
});

// The query string the mounter will see, injected per test.
let currentSearch = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => currentSearch,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../actions", () => ({
  atenderClinicalInfoAction: actionDoubles.makeBoundSpy(),
  atenderDewormingAction: actionDoubles.makeBoundSpy(),
  atenderMedicationStartAction: actionDoubles.makeBoundSpy(),
  atenderMicrochipAction: actionDoubles.atenderMicrochipAction,
  atenderNoteAction: actionDoubles.makeBoundSpy(),
  atenderSterilizationAction: actionDoubles.atenderSterilizationAction,
  atenderVaccinationAction: actionDoubles.makeBoundSpy(),
}));

// The clinical forms are owner-flow components reused verbatim; this test is
// about the ARGUMENT they are handed, not their markup.
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip/MicrochipForm", () => ({
  MicrochipForm: () => null,
}));
vi.mock(
  "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/esterilizacion/SterilizationForm",
  () => ({ SterilizationForm: () => null }),
);
vi.mock(
  "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/antiparasitario/DewormingForm",
  () => ({ DewormingForm: () => null }),
);
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/clinico/ClinicalInfoForm", () => ({
  ClinicalInfoForm: () => null,
}));
vi.mock(
  "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-inicio/MedicationStartForm",
  () => ({ MedicationStartForm: () => null }),
);
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/nota/NoteForm", () => ({
  NoteForm: () => null,
}));
vi.mock("./AtenderVaccinationGate", () => ({ AtenderVaccinationGate: () => null }));

import { AtenderCaptureMounter } from "./AtenderCaptureMounter";
import { PendingSignaturesCard } from "./PendingSignaturesCard";

const { atenderMicrochipAction, atenderSterilizationAction } = actionDoubles;

const ORG_TOKEN = "DIM-A9PJ-B5T7";
const PET_TOKEN = "DIM-DEMO-0002";

// The chip declaration carries NO chip number — not in the summary, not in the
// prefill. This fixture used to read
//
//   summary: "Microchip 985141004321456",
//   prefill: { chipNumber: "985141004321456", occurredAt: "2026-03-04" },
//
// and a test below asserted `params.get("chipNumber")` came back equal to it,
// under the title "keeps the declared prefill alongside the id". That test
// asserted the defect. Reaching this card needs event.write in ANY org plus a
// DIM token, and /perdidas publishes the token of every lost animal with no
// login — so the card handed the exact microchip number that
// app/(public)/p/[publicToken] deliberately renders as "Microchip: Sí/No" to
// anyone who scraped a token. The number now stays server-side; the signer
// types what they scanned and atenderMicrochipAction matches it against the
// declaration inside a SQL predicate (attemptedChipMatchesDeclaration).
const CHIP_DECLARATION: PendingDeclaredEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  eventType: "microchip_implanted",
  summary: "Microchip declarado",
  prefill: { occurredAt: "2026-03-04" },
};

const STERILIZATION_DECLARATION: PendingDeclaredEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  eventType: "sterilization_performed",
  summary: "Castración",
  prefill: { occurredAt: "2025-11-20" },
};

/** Renders the card and returns the CTA href exactly as a user would follow it. */
function ctaHrefFromCard(pending: PendingDeclaredEvent[]): string {
  const { unmount } = render(
    <PendingSignaturesCard
      orgToken={ORG_TOKEN}
      publicToken={PET_TOKEN}
      pending={pending}
      signerMatriculaVerified
    />,
  );
  const link = screen.getByRole("link");
  const href = link.getAttribute("href") ?? "";
  unmount();
  return href;
}

function queryOf(href: string): URLSearchParams {
  const q = href.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : href.slice(q));
}

/** Mounts the capture surface at the given href, as the navigation would. */
function mountAt(href: string) {
  currentSearch = queryOf(href);
  render(<AtenderCaptureMounter orgToken={ORG_TOKEN} publicToken={PET_TOKEN} species="dog" />);
}

afterEach(() => {
  vi.clearAllMocks();
  currentSearch = new URLSearchParams();
});

describe("PendingSignaturesCard — the declared event id reaches the action", () => {
  it("puts confirmEventId in the chip CTA href", () => {
    const params = queryOf(ctaHrefFromCard([CHIP_DECLARATION]));
    expect(params.get("evento")).toBe("chip");
    expect(params.get("confirmEventId")).toBe(CHIP_DECLARATION.id);
  });

  it("puts confirmEventId in the esterilización CTA href", () => {
    const params = queryOf(ctaHrefFromCard([STERILIZATION_DECLARATION]));
    expect(params.get("evento")).toBe("esterilizacion");
    expect(params.get("confirmEventId")).toBe(STERILIZATION_DECLARATION.id);
  });

  it("binds the chip declaration id onto atenderMicrochipAction — via the card href, not a hand-fed argument", () => {
    mountAt(ctaHrefFromCard([CHIP_DECLARATION]));

    expect(atenderMicrochipAction.bind).toHaveBeenCalledTimes(1);
    expect(atenderMicrochipAction.bind).toHaveBeenCalledWith(
      null,
      ORG_TOKEN,
      PET_TOKEN,
      CHIP_DECLARATION.id,
    );
  });

  it("binds the sterilization declaration id onto atenderSterilizationAction — via the card href, not a hand-fed argument", () => {
    mountAt(ctaHrefFromCard([STERILIZATION_DECLARATION]));

    expect(atenderSterilizationAction.bind).toHaveBeenCalledTimes(1);
    expect(atenderSterilizationAction.bind).toHaveBeenCalledWith(
      null,
      ORG_TOKEN,
      PET_TOKEN,
      STERILIZATION_DECLARATION.id,
    );
  });

  it("keeps the non-secret prefill alongside the id (the id must not displace it)", () => {
    const params = queryOf(ctaHrefFromCard([CHIP_DECLARATION]));
    expect(params.get("occurredAt")).toBe("2026-03-04");
  });

  it("never puts the declared microchip number in the CTA href", () => {
    const href = ctaHrefFromCard([CHIP_DECLARATION]);
    const params = queryOf(href);
    // The query string is the leak surface: PendingSignaturesCard spreads
    // `item.prefill` into it, so a chipNumber key here ships the value to any
    // caller who reached the page with a scraped token.
    expect(params.get("chipNumber")).toBeNull();
    expect(href).not.toContain("985141004321456");
  });

  it("never renders the declared microchip number as visible text", () => {
    const { container, unmount } = render(
      <PendingSignaturesCard
        orgToken={ORG_TOKEN}
        publicToken={PET_TOKEN}
        pending={[CHIP_DECLARATION]}
        signerMatriculaVerified={true}
      />,
    );
    // The nudge must still say a chip declaration is waiting — "has a chip" is
    // already public on /p/[publicToken]. It is the NUMBER that is out of scope.
    expect(container.textContent).toContain("Microchip declarado");
    expect(container.textContent).not.toContain("985141004321456");
    unmount();
  });

  it("binds null when the surface is opened WITHOUT a declaration (fresh chip entry)", () => {
    mountAt(`/org/${ORG_TOKEN}/atender/${PET_TOKEN}?evento=chip`);

    expect(atenderMicrochipAction.bind).toHaveBeenCalledWith(null, ORG_TOKEN, PET_TOKEN, null);
  });

  // RA-2 F2 — a signer without a validated matrícula cannot produce a
  // signature, so the CTA must not promise one. The id must still travel:
  // the guard is what stops their retry from duplicating the row.
  it("does not promise a signature to a signer without a validated matrícula", () => {
    render(
      <PendingSignaturesCard
        orgToken={ORG_TOKEN}
        publicToken={PET_TOKEN}
        pending={[CHIP_DECLARATION]}
        signerMatriculaVerified={false}
      />,
    );
    const link = screen.getByRole("link");
    // Exact text, not /firmar/i — "Confirmar" contains "firmar".
    expect(link.textContent).toBe("Confirmar y registrar →");
    expect(queryOf(link.getAttribute("href") ?? "").get("confirmEventId")).toBe(
      CHIP_DECLARATION.id,
    );
    expect(screen.getByText(/la firma seguirá pendiente/i)).toBeTruthy();
  });

  it("promises the signature only to a matriculated signer", () => {
    render(
      <PendingSignaturesCard
        orgToken={ORG_TOKEN}
        publicToken={PET_TOKEN}
        pending={[CHIP_DECLARATION]}
        signerMatriculaVerified
      />,
    );
    expect(screen.getByRole("link").textContent).toBe("Confirmar y firmar →");
    expect(screen.queryByText(/la firma seguirá pendiente/i)).toBeNull();
  });

  it("renders nothing when there is nothing pending", () => {
    const { container } = render(
      <PendingSignaturesCard
        orgToken={ORG_TOKEN}
        publicToken={PET_TOKEN}
        pending={[]}
        signerMatriculaVerified
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
