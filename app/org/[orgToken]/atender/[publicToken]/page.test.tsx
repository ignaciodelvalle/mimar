// Host contract test for the atender walk-in signing page (#43 provenance):
// the "verificado por profesional" copy MUST render only when the signer
// holds a validated matrícula, and the honest org_registered fallback copy
// MUST render only when it doesn't. This pins both branches so a future
// edit can't silently invert the honesty guarantee at line ~83.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const fixturePet = {
  id: "pet-1",
  publicToken: "DIM-TEST-0001",
  name: "Rocco",
  species: "dog",
  status: "active" as const,
};

function fixtureAccess(matriculaVerified: boolean) {
  return {
    ok: true as const,
    user: { id: "user-1" },
    organizationId: "org-1",
    organizationName: "Refugio Test",
    pet: fixturePet,
    signer: {
      label: matriculaVerified ? "matrícula 12345" : "Refugio Test",
      matriculaVerified,
    },
    eventAuthorship: matriculaVerified
      ? { authorRole: "vet" as const, authorOrganizationId: "org-1", authorVerified: true }
      : { authorRole: "shelter" as const, authorOrganizationId: "org-1", authorVerified: false },
    error: null,
  };
}

const resolveAtenderPetMock = vi.fn();

vi.mock("../atender-access", () => ({
  resolveAtenderPet: (...args: unknown[]) => resolveAtenderPetMock(...args),
}));

// #3 declared-events card — mocked so this host-contract test stays scoped to
// the #43 provenance copy and never needs a real DB connection for the
// fixture's non-UUID pet id.
vi.mock("../atender-declared-events", () => ({
  fetchPendingDeclaredEvents: vi.fn().mockResolvedValue([]),
}));

// The observation's started event — the page reads its deadline only when the
// close card is on screen. Mocked for the same reason as the card above.
const findLatestObservationStartedMock = vi.fn();
vi.mock("@/src/modules/surveillance/infrastructure/surveillance-repository", () => ({
  SurveillanceRepository: class {
    findLatestObservationStarted(...args: unknown[]) {
      return findLatestObservationStartedMock(...args);
    }
  },
}));

import AtenderSignPage from "./page";

async function renderPage(searchParams: { evento?: string; firmado?: string } = {}) {
  const node = await AtenderSignPage({
    params: Promise.resolve({ orgToken: "org-token", publicToken: "DIM-TEST-0001" }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(node);
}

describe("atender sign page — #43 provenance copy", () => {
  it("renders the honest org_registered fallback when the signer's matrícula is NOT verified", async () => {
    resolveAtenderPetMock.mockResolvedValueOnce(fixtureAccess(false));
    const html = await renderPage();
    // The exact inline suffix from page.tsx:83 (" · verificado por profesional")
    // must be ABSENT — not just the bare substring, which also legitimately
    // appears (quoted) inside the honest fallback paragraph below.
    expect(html).not.toContain("· verificado por profesional");
    expect(html).toContain("Queda registrado a nombre de la organización");
  });

  it("renders the 'verificado por profesional' copy when the signer's matrícula IS verified", async () => {
    resolveAtenderPetMock.mockResolvedValueOnce(fixtureAccess(true));
    const html = await renderPage();
    expect(html).toContain("· verificado por profesional");
    expect(html).not.toContain("Queda registrado a nombre de la organización");
  });
});

// RA-2 F2 — the success receipt. A non-matriculated signer's write lands as
// `org_registered`, which is a record and NOT a signature, so the page claiming
// "Evento clínico firmado." was false for that entire signer tier — and, next
// to a pending-signature card that correctly did not clear, it read as a broken
// write and invited the duplicate that permanently pollutes the health record.
describe("atender sign page — ?firmado=1 receipt must match the signer's tier", () => {
  it("does NOT claim a signature when the signer has no validated matrícula", async () => {
    resolveAtenderPetMock.mockResolvedValueOnce(fixtureAccess(false));
    const html = await renderPage({ firmado: "1" });
    expect(html).not.toContain("Evento clínico firmado.");
    expect(html).toContain("Evento registrado a nombre de la organización.");
    expect(html).toContain("no lleva firma profesional");
  });

  it("claims the signature only for a matriculated signer", async () => {
    resolveAtenderPetMock.mockResolvedValueOnce(fixtureAccess(true));
    const html = await renderPage({ firmado: "1" });
    expect(html).toContain("Evento clínico firmado.");
    expect(html).not.toContain("Evento registrado a nombre de la organización.");
  });

  it("shows no receipt at all while a capture form is open", async () => {
    resolveAtenderPetMock.mockResolvedValueOnce(fixtureAccess(false));
    const html = await renderPage({ firmado: "1", evento: "chip" });
    expect(html).not.toContain("Evento registrado a nombre de la organización.");
    expect(html).not.toContain("Evento clínico firmado.");
  });
});

// PO decision 2026-09-18 — a veterinarian may not close a rabies observation as
// NEGATIVE before it ends. The server refuses it; this screen must show when the
// observation ends and must not offer that close as if it were available.
describe("atender sign page — the observation close waits for the deadline", () => {
  // 12:00 UTC = 09:00 in Argentina.
  const DEADLINE = new Date("2026-09-24T12:00:00.000Z");

  function observedAccess(matriculaVerified: boolean) {
    const base = fixtureAccess(matriculaVerified);
    return { ...base, pet: { ...base.pet, rabiesObservationStatus: "in_progress" } };
  }

  beforeEach(() => {
    findLatestObservationStartedMock.mockResolvedValue({
      id: "started-1",
      occurredAt: new Date("2026-09-14T12:00:00.000Z"),
      payload: { observation_until: DEADLINE.toISOString() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the estimated end, in the State screen's words", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain("Observación activa");
    expect(html).toContain("Cierre estimado: 24 de sept de 2026");
  });

  it("before the deadline, offers the negative DISABLED and says from when", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain(
      '<option value="negative" disabled="">Negativo — disponible desde el 24 de septiembre de 2026 a las 09:00</option>',
    );
    expect(html).toContain("El resultado negativo se habilita cuando termina el período");
    // A positive does not wait (PO D1).
    expect(html).toMatch(/<option value="positive_rabies">/);
  });

  it("before the deadline, the bare death close is DISABLED and the hint sends the vet to the death door (PO D1 + D8)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain(
      '<option value="dead" disabled="">Fallecido — disponible desde el 24 de septiembre de 2026 a las 09:00</option>',
    );
    // D8: the clinic now records the death itself — the old "desde la clínica
    // no se registra la muerte" is gone, and the door it names is on screen.
    expect(html).toContain("usá “Registrar muerte durante la observación”, más abajo");
    expect(html).not.toContain("Desde la clínica no se registra la muerte");
    expect(html).toContain("Registrar muerte durante la observación</button>");
  });

  it("offers the death door only to a licensed vet, and only while the observation runs (PO D8)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    const DOOR = "Registrar muerte durante la observación</button>";

    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(false));
    expect(await renderPage({ evento: "observacion" })).not.toContain(DOOR);

    const expired = observedAccess(true);
    resolveAtenderPetMock.mockResolvedValueOnce({
      ...expired,
      pet: { ...expired.pet, rabiesObservationStatus: "window_expired_unclosed" },
    });
    expect(await renderPage({ evento: "observacion" })).not.toContain(DOOR);

    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));
    expect(await renderPage({ evento: "observacion" })).toContain(DOOR);
  });

  it("never offers 'sin seguimiento' to the vet, and says why — before or after the deadline", async () => {
    for (const now of ["2026-09-18T15:00:00.000Z", "2026-09-24T13:00:00.000Z"]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

      const html = await renderPage({ evento: "observacion" });

      expect(html, now).not.toContain('value="lost_to_followup"');
      expect(html, now).toContain("“Sin seguimiento” no se registra desde la clínica");
    }
  });

  it("after the deadline, the death is an ordinary option again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T13:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain(
      '<option value="dead">Fallecido — fallecimiento durante la observación</option>',
    );
  });

  it("after the deadline, the negative is an ordinary option again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T13:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(true));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain(
      '<option value="negative">Negativo — animal sano tras observación</option>',
    );
    expect(html).not.toContain("disponible desde el");
  });

  it("shows the estimated end to a member without matrícula too — it is not a licence matter", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-18T15:00:00.000Z"));
    resolveAtenderPetMock.mockResolvedValueOnce(observedAccess(false));

    const html = await renderPage({ evento: "observacion" });

    expect(html).toContain("Cierre estimado: 24 de sept de 2026");
    expect(html).toContain("lo registra un profesional con matrícula validada");
  });
});
