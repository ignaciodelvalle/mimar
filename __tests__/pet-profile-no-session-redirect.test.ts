// Route test — /mis-mascotas/[publicToken] (the pet profile page).
//
// Regression guard for the external audit (2026-07): an expired/absent session
// on this route rendered a 404 instead of redirecting to login. The page treated
// EVERY requirePetAccess !ok as notFound(), conflating "no session" with "no
// permission". The fix branches on the structural `reason` discriminator:
//   - reason "no-session"            → redirect(/iniciar-sesion?returnTo=<this path>)
//   - reason "not-found-or-forbidden" → notFound()  (unchanged, no info leak)
//
// Strategy mirrors eventos-nuevo-redirect.test.ts: mock next/navigation to
// capture redirect()/notFound() targets, and mock @/lib/infra/pet-access so the
// page short-circuits at the auth branch before any DB access.

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "DIM-TEST-0001";

// ---------------------------------------------------------------------------
// Mock: next/navigation — capture redirect()/notFound() targets. Both throw in
// real Next.js to halt rendering; emulate that so the page stops at the branch.
// ---------------------------------------------------------------------------

const { mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockRedirect: vi.fn((url: string): never => {
    throw new Error(`REDIRECT:${url}`);
  }),
  mockNotFound: vi.fn((): never => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
  notFound: () => mockNotFound(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/pet-access — control the access result per test.
// ---------------------------------------------------------------------------

const { mockRequirePetAccess } = vi.hoisted(() => ({
  mockRequirePetAccess: vi.fn(),
}));

vi.mock("@/lib/infra/pet-access", () => ({
  requirePetAccess: (token: string) => mockRequirePetAccess(token),
}));

import PetDetailPage from "@/app/(app)/mis-mascotas/[publicToken]/page";

describe("pet profile — no-session vs no-permission (audit 2026-07)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockNotFound.mockClear();
    mockRequirePetAccess.mockReset();
  });

  it("redirects an expired/absent session to /iniciar-sesion carrying returnTo", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: false, reason: "no-session" });

    await expect(
      PetDetailPage({
        params: Promise.resolve({ publicToken: TOKEN }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/REDIRECT:/);

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    const target = mockRedirect.mock.calls[0]?.[0] as string;
    expect(target.startsWith("/iniciar-sesion?returnTo=")).toBe(true);
    const returnTo = new URL(target, "http://x").searchParams.get("returnTo");
    expect(returnTo).toBe(`/mis-mascotas/${TOKEN}`);
  });

  it("still 404s a resolvable session without permission (no info leak, no login bounce)", async () => {
    mockRequirePetAccess.mockResolvedValue({ ok: false, reason: "not-found-or-forbidden" });

    await expect(
      PetDetailPage({
        params: Promise.resolve({ publicToken: TOKEN }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NOT_FOUND");

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
