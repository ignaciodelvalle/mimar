// "Invitación enviada" is rendered from the pending invitation in the database,
// so the refresh a revalidating action triggers cannot take it away (2026-10-06).
// See caretakerInviteSentPath for the bug this replaces: the success screen was
// state in DesignateCaretakerForm, which `/cuidado` unmounts once an invitation
// is pending.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTitularAccess: vi.fn(),
  getCaretakerStateForPet: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));
vi.mock("@/lib/infra/pet-access", () => ({ requireTitularAccess: mocks.requireTitularAccess }));
vi.mock("@/src/modules/caretakers/application/get-caretaker-state-for-pet", () => ({
  getCaretakerStateForPet: mocks.getCaretakerStateForPet,
}));
vi.mock("@/src/modules/caretakers/infrastructure/caretakers-repository", () => ({
  CaretakersRepository: {},
}));

import { caretakerInviteSentPath } from "../invite-sent-path";
import CaretakerInviteSentPage from "./page";

const TOKEN = "DIM-CARE-0001";
const params = Promise.resolve({ publicToken: TOKEN });

const PENDING = {
  grantId: "g-1",
  grantPublicToken: "CG-abc123",
  caretakerEmail: "ana@example.com",
  caretakerUserId: null,
  startsAt: new Date("2026-10-06T03:00:00Z"),
  endsAt: new Date("2026-10-20T03:00:00Z"),
};

async function render() {
  return renderToStaticMarkup(await CaretakerInviteSentPage({ params }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireTitularAccess.mockResolvedValue({
    ok: true,
    pet: { id: "pet-1", publicToken: TOKEN, name: "Pampa" },
  });
});

describe("/cuidado/invitacion-enviada", () => {
  it("is the path the designation form navigates to", () => {
    expect(caretakerInviteSentPath(TOKEN)).toBe(
      `/mis-mascotas/${TOKEN}/cuidado/invitacion-enviada`,
    );
  });

  it("names the invitee from the pending invitation", async () => {
    mocks.getCaretakerStateForPet.mockResolvedValue({
      active: null,
      pending: PENDING,
      recentlyEnded: null,
    });
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain("Invitación enviada");
    expect(html).toContain("Le avisamos a ana@example.com.");
    expect(html).toContain(`href="/mis-mascotas/${TOKEN}"`);
  });

  it("sends a titular with no pending invitation back to /cuidado", async () => {
    mocks.getCaretakerStateForPet.mockResolvedValue({
      active: null,
      pending: null,
      recentlyEnded: null,
    });
    await expect(render()).rejects.toThrow(`NEXT_REDIRECT:/mis-mascotas/${TOKEN}/cuidado`);
  });

  it("sends a non-titular back to /cuidado, which explains why", async () => {
    mocks.requireTitularAccess.mockResolvedValue({
      ok: false,
      reason: "not-titular",
      error: "x",
    });
    await expect(render()).rejects.toThrow(`NEXT_REDIRECT:/mis-mascotas/${TOKEN}/cuidado`);
    expect(mocks.getCaretakerStateForPet).not.toHaveBeenCalled();
  });
});
