// Host contract test for the /anotar fallback page (pet-document-redesign
// D4, REQ-4.2, ADR-5): "?sheet=anotar" is now the PRIMARY in-profile entry
// point, but design chose to KEEP `/anotar` as a fallback host page (not a
// redirect) — deep links (buildCaptureDeeplink), e2e, and the
// /eventos/nuevo redirect doctrine (AGENTS.md rule 5) still resolve here.
// This test asserts the fallback still renders the standalone wizard
// (CaptureBox) + the full discoverability list (CaptureOptionsList) —
// the exact contract REQ-4.2 requires be observable.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mis-mascotas/abc123/anotar",
}));

const fixturePet = {
  id: "pet-1",
  publicToken: "abc123",
  name: "Firulais",
  species: "dog",
};

vi.mock("@/lib/infra/pets", () => ({
  requireOwnedPetByToken: vi.fn(async () => ({
    user: { id: "user-1" },
    pet: fixturePet,
    accessPath: "owner",
    organization: null,
  })),
}));

// QA A9: the page resolves the check-in gate server-side; default to
// non-adopter (entry hidden). Individual tests override via mockResolvedValue.
const isPetAdoptedByUserMock = vi.fn(async (_petId: string, _userId: string) => false);
vi.mock("@/lib/infra/adoption-checkin", () => ({
  isPetAdoptedByUser: (petId: string, userId: string) => isPetAdoptedByUserMock(petId, userId),
}));

import CapturePage from "./page";

describe("/anotar fallback host page — REQ-4.2 host contract", () => {
  it("renders the standalone wizard (CaptureBox) — capture textarea present", async () => {
    const node = await CapturePage({
      params: Promise.resolve({ publicToken: "abc123" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("capture-text");
    expect(html).toContain("Identificar");
  });

  it("renders the full discoverability list (CaptureOptionsList) grouped by category", async () => {
    const node = await CapturePage({
      params: Promise.resolve({ publicToken: "abc123" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Salud");
    expect(html).toContain("Registrar vacuna");
    expect(html).toContain("Identificación");
  });

  it("header greets the pet by name (standalone page identity, unchanged)", async () => {
    const node = await CapturePage({
      params: Promise.resolve({ publicToken: "abc123" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Anotar algo de Firulais");
  });

  it("QA A9: hides the check-in entry for a non-adopter viewer", async () => {
    isPetAdoptedByUserMock.mockResolvedValueOnce(false);
    const node = await CapturePage({
      params: Promise.resolve({ publicToken: "abc123" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain("Check-in post-adopción");
  });

  it("QA A9: shows the check-in entry when the viewer is the registered adopter", async () => {
    isPetAdoptedByUserMock.mockResolvedValueOnce(true);
    const node = await CapturePage({
      params: Promise.resolve({ publicToken: "abc123" }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Check-in post-adopción");
    expect(isPetAdoptedByUserMock).toHaveBeenCalledWith("pet-1", "user-1");
  });
});
