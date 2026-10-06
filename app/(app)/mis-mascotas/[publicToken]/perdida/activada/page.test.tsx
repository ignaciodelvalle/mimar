// The lost-search confirmation is a SERVER RENDER of the database's state, not
// client state that has to survive a refresh (2026-10-06).
//
// THE BUG THIS PINS. MarkLostWizard used to flip `submitted` after
// setPetLostAction resolved and draw "Activamos la búsqueda de X" in place. The
// action revalidates, Next 15.5 re-renders the current route in the same
// response, and `/perdida` renders UpdateLastSeenForm for a lost pet — so the
// wizard, its flag and the WhatsApp/poster buttons were gone before they showed.
//
// The second describe renders `/perdida` itself in the post-action state to keep
// that mechanism on record: whatever a lost pet's `/perdida` renders, it is not
// the confirmation, so the confirmation cannot live there. The first renders the
// route the wizard now navigates to, from nothing but what the database holds
// after the action — exactly what a fresh request (or a reload) sees.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwnedPetByToken: vi.fn(),
  fetchLostEpisodeForPet: vi.fn(),
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
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

vi.mock("@/lib/infra/pets", () => ({ requireOwnedPetByToken: mocks.requireOwnedPetByToken }));

vi.mock("@/lib/infra/lost-mode", () => ({
  fetchLostEpisodeForPet: mocks.fetchLostEpisodeForPet,
  fetchLatestLostDescription: vi.fn(async () => null),
}));

// Only for the `/perdida` render below: its two forms are stubbed to a marker,
// because what is under test is WHICH branch the page takes, not the forms.
vi.mock("@/lib/infra/pet-identifiers", () => ({
  fetchActiveIdentifications: vi.fn(async () => ({ microchip: null, tattoo: null })),
}));
vi.mock("@/lib/place/home-suggestion", () => ({ petHomeSuggestion: vi.fn(async () => null) }));
vi.mock("@/src/modules/events/actions", () => ({
  setPetLostAction: { bind: () => vi.fn() },
  updateLostLastSeenAction: { bind: () => vi.fn() },
}));
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/perdida/UpdateLastSeenForm", () => ({
  UpdateLastSeenForm: () => React.createElement("div", { "data-stub": "update-last-seen-form" }),
}));
vi.mock("@/app/(app)/mis-mascotas/[publicToken]/perdida/MarkLostWizard", () => ({
  MarkLostWizard: () => React.createElement("div", { "data-stub": "mark-lost-wizard" }),
}));

import MarkPetLostPage from "@/app/(app)/mis-mascotas/[publicToken]/perdida/page";
import { lostActivatedPath } from "../lost-activation";
import LostSearchActivatedPage from "./page";

const TOKEN = "DIM-LOST-0001";

function petIn(status: string) {
  return {
    user: { id: "user-1" },
    accessPath: "owner" as const,
    organization: null,
    holderRole: "owner",
    pet: {
      id: "pet-1",
      publicToken: TOKEN,
      name: "Luna",
      sex: "female",
      status,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Palermo",
    },
  };
}

/** What `fetchLostEpisodeForPet` returns once setPetLostWriter opened the case. */
const OPEN_EPISODE = {
  caseId: "case-1",
  publicCode: "CAS-TEST-0001",
  openedAt: new Date("2026-10-06T12:00:00Z"),
  placeName: null,
  ownerNote: null,
  lastSeenLat: null,
  lastSeenLng: null,
  lastSeenAt: new Date("2026-10-06T12:00:00Z"),
  sightingsCount: 0,
};

const params = Promise.resolve({ publicToken: TOKEN });

async function render(page: (p: { params: typeof params }) => Promise<React.ReactElement>) {
  return renderToStaticMarkup(await page({ params }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/perdida/activada — the confirmation is rendered from the database", () => {
  it("is the path the wizard navigates to", () => {
    expect(lostActivatedPath(TOKEN)).toBe(`/mis-mascotas/${TOKEN}/perdida/activada`);
  });

  it("renders the confirmation and its three exits for a pet with an open lost episode", async () => {
    mocks.requireOwnedPetByToken.mockResolvedValue(petIn("lost"));
    mocks.fetchLostEpisodeForPet.mockResolvedValue(OPEN_EPISODE);

    const html = await render(LostSearchActivatedPage);

    expect(html).toContain("<h1");
    expect(html).toContain("Activamos la búsqueda de Luna");
    // WhatsApp carries the gendered share text and an ABSOLUTE credential URL —
    // a relative one is unclickable on the stranger's phone it is sent to.
    const wa = html.match(/href="(https:\/\/wa\.me\/\?text=[^"]+)"/);
    expect(wa, "the WhatsApp exit").not.toBeNull();
    const text = decodeURIComponent((wa?.[1] ?? "").replace("https://wa.me/?text=", ""));
    expect(text).toMatch(/^Luna está perdida — ayudanos a que vuelva a casa\. Su perfil público: /);
    expect(text).toMatch(new RegExp(`https?://[^ ]+/p/${TOKEN}$`));
    expect(html).toContain(`href="/mis-mascotas/${TOKEN}/cartel"`);
    expect(html).toContain("Imprimir cartel A4");
    expect(html).toContain(`href="/mis-mascotas/${TOKEN}"`);
    expect(mocks.fetchLostEpisodeForPet).toHaveBeenCalledWith("pet-1");
  });

  it("sends a pet that is not lost back to its profile (no receipt for a search that is not running)", async () => {
    mocks.requireOwnedPetByToken.mockResolvedValue(petIn("active"));
    await expect(render(LostSearchActivatedPage)).rejects.toThrow(
      `NEXT_REDIRECT:/mis-mascotas/${TOKEN}`,
    );
    expect(mocks.fetchLostEpisodeForPet).not.toHaveBeenCalled();
  });

  it("sends a lost pet whose episode auto-closed back to its profile", async () => {
    mocks.requireOwnedPetByToken.mockResolvedValue(petIn("lost"));
    mocks.fetchLostEpisodeForPet.mockResolvedValue(null);
    await expect(render(LostSearchActivatedPage)).rejects.toThrow(
      `NEXT_REDIRECT:/mis-mascotas/${TOKEN}`,
    );
  });
});

describe("/perdida after the action — why the confirmation cannot live there", () => {
  it("mounts the wizard for an active pet", async () => {
    mocks.requireOwnedPetByToken.mockResolvedValue(petIn("active"));
    const html = await render(MarkPetLostPage);
    expect(html).toContain('data-stub="mark-lost-wizard"');
  });

  it("re-renders WITHOUT the wizard once the pet is lost — the refresh the action triggers", async () => {
    mocks.requireOwnedPetByToken.mockResolvedValue(petIn("lost"));
    mocks.fetchLostEpisodeForPet.mockResolvedValue(OPEN_EPISODE);
    const html = await render(MarkPetLostPage);
    expect(html).toContain('data-stub="update-last-seen-form"');
    expect(html).not.toContain('data-stub="mark-lost-wizard"');
    expect(html).not.toContain("Activamos la búsqueda");
  });
});
