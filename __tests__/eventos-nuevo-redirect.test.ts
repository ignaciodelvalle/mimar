// Route test — /mis-mascotas/[publicToken]/eventos/nuevo is the duplicate
// event catalog and, in pet profile v2.1 (Item 6, spec §3.3 / D7), becomes a
// permanent redirect to the single canonical capture hub /anotar.
//
// Same redirect pattern already used by /libreta, /historial and /vacunas
// (HTTP 308 via permanentRedirect). The form SUB-routes
// (eventos/nuevo/vacuna, …/embarazo, …) are untouched — only the catalog
// INDEX redirects. This test pins:
//   1. the index redirects to .../anotar
//   2. forwarded query params (text / kind) are preserved on the redirect

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "DIM-TEST-TOKEN";

// ---------------------------------------------------------------------------
// Mock: next/navigation — capture the permanentRedirect target.
// ---------------------------------------------------------------------------

const { mockPermanentRedirect, mockNotFound } = vi.hoisted(() => ({
  mockPermanentRedirect: vi.fn((url: string) => {
    // Real permanentRedirect throws to halt rendering; emulate that so the
    // page function does not continue past the call.
    throw new Error(`REDIRECT:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  permanentRedirect: (url: string) => mockPermanentRedirect(url),
  notFound: () => mockNotFound(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/pet-access — grant access to a fake active pet.
// ---------------------------------------------------------------------------

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: vi.fn(async () => ({
    ok: true,
    pet: { publicToken: TOKEN, name: "Roma", status: "active", species: "dog", sex: "female" },
  })),
}));

import PickEventPage from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/page";

describe("/eventos/nuevo → /anotar redirect (Item 6, D7)", () => {
  beforeEach(() => {
    mockPermanentRedirect.mockClear();
    mockNotFound.mockClear();
  });

  it("permanently redirects the catalog index to /anotar", async () => {
    await expect(
      PickEventPage({
        params: Promise.resolve({ publicToken: TOKEN }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/REDIRECT:/);

    expect(mockPermanentRedirect).toHaveBeenCalledTimes(1);
    expect(mockPermanentRedirect).toHaveBeenCalledWith(`/mis-mascotas/${TOKEN}/anotar`);
  });

  it("preserves forwarded query params (text / kind) on the redirect", async () => {
    await expect(
      PickEventPage({
        params: Promise.resolve({ publicToken: TOKEN }),
        searchParams: Promise.resolve({
          text: "vacuna antirrábica",
          kind: "vaccination_administered",
        }),
      }),
    ).rejects.toThrow(/REDIRECT:/);

    const target = mockPermanentRedirect.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`/mis-mascotas/${TOKEN}/anotar?`)).toBe(true);
    const qs = new URL(target, "http://x").searchParams;
    expect(qs.get("text")).toBe("vacuna antirrábica");
    expect(qs.get("kind")).toBe("vaccination_administered");
  });
});
