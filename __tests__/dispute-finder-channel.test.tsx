// The finder channel survives a custody dispute (PO decision 2026-07-30).
//
// WHAT WENT WRONG
// ---------------
// D2 hardening (red-team 2026-07) correctly stopped both owner-relay flows on
// a credential whose titularidad is under review: /p/[token]/sighting and
// /p/[token]/encontre each end in a notification (and, for the sighting, an
// owner-visible timeline payload) carrying the finder's name and phone. Sending
// that to a contested owner takes sides in a legal dispute.
//
// The replacement was the bug. Both routes returned a notice reading "Si tenés
// información, será dirigida a la autoridad competente" followed by a single
// link back to the profile. The promise was true — the neutral tip path
// (DisputeTipForm → report-dispute-tip.ts, which appends a finder_tip to the
// open dispute case where only the reviewing authority reads it) has existed
// since 2026-07-24 — but it lived on a DIFFERENT page, and nothing on these two
// said so. A person standing over a strange animal, who scanned a QR and
// followed the one CTA the credential offered, read a promise and hit a dead
// end. The animal in the middle of the dispute is the one that loses.
//
// WHAT THIS FILE PINS
// -------------------
//   1. Both routes still refuse the owner relay (no sighting form, no
//      in-possession form) — the D2 property, unchanged.
//   2. Both routes now RENDER the neutral tip form, bound to the same token —
//      the channel is conserved, its destination moved. This is what fails
//      against the pre-2026-07-30 code, which rendered a link and nothing else.
//   3. The copy states the routing and withholds the reason: a stranger who
//      found an animal is told where their message goes (they must not be
//      allowed to believe the owner was notified) but not that two people are
//      fighting over it. See lib/ui/dispute-copy.ts.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPUTE_TIP_HEADING, DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

// The tip form is a client component wired to a "use server" action; this test
// is about which page mounts it, not about what it submits (that contract lives
// in report-dispute-tip.test.ts). The spy dumps its props so the binding —
// right token, right page — is assertable.
vi.mock("@/app/(public)/p/[publicToken]/DisputeTipForm", () => ({
  DisputeTipForm: vi.fn((props: Record<string, unknown>) =>
    React.createElement("form", { "data-testid": "dispute-tip-form" }, JSON.stringify(props)),
  ),
}));

// The two owner-relay forms. If either renders on a disputed credential, D2 is
// broken — so they are stubbed with loud, greppable markers.
vi.mock("@/app/(public)/p/[publicToken]/sighting/PetSightingForm", () => ({
  PetSightingForm: vi.fn(() =>
    React.createElement("form", { "data-testid": "OWNER-RELAY-sighting" }),
  ),
}));
vi.mock("@/app/(public)/p/[publicToken]/encontre/FinderInPossessionForm", () => ({
  FinderInPossessionForm: vi.fn(() =>
    React.createElement("form", { "data-testid": "OWNER-RELAY-encontre" }),
  ),
}));

const mockDbSelect = vi.fn();
vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
  pets: {},
  attachments: {},
  ownerships: {},
  profiles: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => (await importOriginal()) as object);

vi.mock("@/lib/infra/lost-mode", () => ({
  fetchLostEpisodeForPet: vi.fn(async () => null),
  publicSightingMapCenter: vi.fn(() => null),
}));
vi.mock("@/lib/utils/format", () => ({
  sightingPhrase: vi.fn(() => "La vi cerca de acá"),
  foundPossessivePhrase: vi.fn(() => "La tengo conmigo"),
}));
vi.mock("@/lib/infra/storage", () => ({ petPhotoUrl: vi.fn(() => null) }));
vi.mock("@/lib/infra/report-error", () => ({ reportError: vi.fn() }));
vi.mock("@/components/Icon", () => ({ Icon: vi.fn(() => null) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: null } })) } },
  })),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = "DIM-DISP-CHANNEL";

// A lost, disputed pet with the finder form allowed — i.e. every gate BELOW the
// dispute check would let the owner-relay flow through. The dispute is the only
// thing standing between this render and a notification to a contested owner.
const DISPUTED_PET = {
  id: "pet-0000-0000-0000-000000000001",
  name: "Luna",
  sex: "female",
  status: "lost",
  publicToken: TOKEN,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "Quilmes",
  discloseLastLocationWhenLost: false,
  allowFinderFormWhenLost: true,
  disclosePhoneWhenLost: true,
  discloseEmailWhenLost: true,
  inCustodyDispute: true,
};

/** Drizzle chain stub: every terminal `.limit()` yields `rows`. */
function stubSelect(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(async () => rows);
  mockDbSelect.mockReturnValue(chain);
}

async function renderSightingRoute(): Promise<string> {
  // The sighting page selects scalar columns off `pets`.
  stubSelect([DISPUTED_PET]);
  const { default: Page } = await import("@/app/(public)/p/[publicToken]/sighting/page");
  const el = await Page({ params: Promise.resolve({ publicToken: TOKEN }) });
  return renderToStaticMarkup(el as React.ReactElement);
}

async function renderEncontreRoute(): Promise<string> {
  // The encontre page selects `{ pet, photo }` from a leftJoin.
  stubSelect([{ pet: DISPUTED_PET, photo: null }]);
  const { default: Page } = await import("@/app/(public)/p/[publicToken]/encontre/page");
  const el = await Page({ params: Promise.resolve({ publicToken: TOKEN }) });
  return renderToStaticMarkup(el as React.ReactElement);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("disputed credential — the finder keeps a way to reach the authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("/p/[token]/sighting: renders the neutral tip form instead of a dead end", async () => {
    const html = await renderSightingRoute();

    // THE change. Before 2026-07-30 this route rendered a notice plus a single
    // "Ver el perfil público" link — a promise of routing with nothing to
    // write in. Asserting merely "no relay form" would have passed on the dead
    // end too, which is exactly how the dead end survived review, so the
    // presence of the form is what gets pinned.
    expect(html).toContain('data-testid="dispute-tip-form"');
    // Bound to THIS credential — a form pointed at the wrong token would file
    // the tip on someone else's case.
    expect(html).toContain(`&quot;publicToken&quot;:&quot;${TOKEN}&quot;`);

    // D2 still holds: the owner-relay form is not on the page.
    expect(html).not.toContain("OWNER-RELAY-sighting");
  });

  it("/p/[token]/encontre: renders the neutral tip form instead of a dead end", async () => {
    const html = await renderEncontreRoute();

    // This route matters more than the sighting one: whoever reaches it is
    // holding the animal.
    expect(html).toContain('data-testid="dispute-tip-form"');
    expect(html).toContain(`&quot;publicToken&quot;:&quot;${TOKEN}&quot;`);
    expect(html).not.toContain("OWNER-RELAY-encontre");
  });

  it("both routes tell the finder where the message goes, and never why", async () => {
    for (const [route, html] of [
      ["sighting", await renderSightingRoute()],
      ["encontre", await renderEncontreRoute()],
    ] as const) {
      // Honest: the finder is told the owner is NOT the recipient. Letting them
      // walk away believing the owner was notified is the one lie that costs
      // the animal its way home.
      expect(html, `${route}: routing heading missing`).toContain(DISPUTE_TIP_HEADING);
      expect(html, `${route}: routing sentence missing`).toContain(DISPUTE_TIP_INTRO);

      // Discreet: a stranger who found an animal is not told that two people
      // are fighting over it. These are the words the old notice used.
      expect(html, `${route}: leaks the dispute to the finder`).not.toMatch(/titularidad/i);
      expect(html, `${route}: leaks the dispute to the finder`).not.toMatch(/en revisión/i);
      expect(html, `${route}: leaks the dispute to the finder`).not.toMatch(/las partes/i);
      expect(html, `${route}: leaks the dispute to the finder`).not.toMatch(/disputa/i);
    }
  });
});
