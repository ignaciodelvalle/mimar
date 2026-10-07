// /perdida/activada is the OWNER's receipt: who is searching, and the share
// link. It goes through the real requireOwnedPetByToken (lib/infra/pets.ts);
// only the access resolver underneath is faked, so these pin what a stranger
// and an expired session get — and that neither reaches the episode lookup.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePetAccess: vi.fn(),
  fetchLostEpisodeForPet: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/infra/pet-access", () => ({ requirePetAccess: mocks.requirePetAccess }));
vi.mock("@/lib/infra/lost-mode", () => ({ fetchLostEpisodeForPet: mocks.fetchLostEpisodeForPet }));

import LostSearchActivatedPage from "./page";

const params = Promise.resolve({ publicToken: "DIM-LOST-0001" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/perdida/activada — denied access", () => {
  it("answers notFound() to a signed-in user with no access to the pet", async () => {
    mocks.requirePetAccess.mockResolvedValue({ ok: false, error: "Mascota no encontrada." });
    await expect(LostSearchActivatedPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.fetchLostEpisodeForPet).not.toHaveBeenCalled();
  });

  it("sends an expired session to sign in", async () => {
    mocks.requirePetAccess.mockResolvedValue({ ok: false, error: "Sesión expirada." });
    await expect(LostSearchActivatedPage({ params })).rejects.toThrow(
      "NEXT_REDIRECT:/iniciar-sesion",
    );
    expect(mocks.fetchLostEpisodeForPet).not.toHaveBeenCalled();
  });
});
