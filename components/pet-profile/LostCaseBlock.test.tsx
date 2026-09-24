// Tests for <LostCaseBlock> — pet-document-redesign S2 (lost-as-case-block)
// + ADR-18 STALE variant.
//
// Covers: no-open-episode renders the STALE banner (not nothing), owner sees
// all applicable capabilities (Marcar encontrada, actualizar last-seen,
// share/poster, disclosure toggles), org gets the read-only variant (no
// toggles, no Marcar encontrada, no /perdida update, no share/poster).
// Render via react-dom/server → HTML string (same pattern as
// LostLastSeenCard.test.tsx — "use client" components with no browser-only
// hooks render fine this way).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LostCaseBlock, type LostCaseBlockPet } from "./LostCaseBlock";
import type { ScanFeedItem } from "./LostScanFeed";

const pet: LostCaseBlockPet = {
  id: "pet-1",
  name: "Firulais",
  publicToken: "abc123",
  sex: "male",
  discloseFirstNameWhenLost: true,
  disclosePhoneWhenLost: false,
  discloseEmailWhenLost: false,
  discloseLastLocationWhenLost: true,
  allowFinderFormWhenLost: true,
  discloseCaretakerContactWhenLost: false,
};

const episode = {
  id: "ep-1",
  publicCode: "LOS-00042",
  openedAt: new Date("2026-06-20T10:00:00Z"),
  jurisdictionLocality: "La Plata",
  placeName: "Plaza Italia",
  ownerNote: "Salió por la puerta del frente",
  sightingsCount: 2,
  lastSeenAt: new Date("2026-06-20T10:00:00Z"),
  lastSeenLat: null,
  lastSeenLng: null,
};

const scans: ScanFeedItem[] = [
  {
    kind: "scan",
    id: "s1",
    at: new Date("2026-06-21T10:00:00Z"),
    count: 1,
    localityLabel: "La Plata",
  },
];

function render(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(node);
}

describe("<LostCaseBlock> — STALE variant (ADR-18, no open episode while status still lost)", () => {
  it("owner: renders the stale banner with both CTAs, not an empty block", () => {
    const html = render(
      <LostCaseBlock
        pet={pet}
        photoUrl={null}
        episode={null}
        scans={[]}
        ownerFirstName="Ana"
        alertsOriginShelter={false}
        isOwner={true}
        canManageDisclosure={true}
      />,
    );
    expect(html).not.toBe("");
    expect(html).toContain("Búsqueda cerrada por inactividad");
    expect(html).toContain("Reactivar búsqueda");
    expect(html).toContain("Apareció");
    expect(html).toContain('data-lost-case-variant="stale"');
  });

  it("org: renders the informational banner without CTAs", () => {
    const html = render(
      <LostCaseBlock
        pet={pet}
        photoUrl={null}
        episode={null}
        scans={[]}
        ownerFirstName="Ana"
        alertsOriginShelter={false}
        isOwner={false}
        canManageDisclosure={false}
      />,
    );
    expect(html).toContain("Búsqueda cerrada por inactividad");
    expect(html).not.toContain("Reactivar búsqueda");
    expect(html).not.toContain("Apareció");
  });
});

describe("<LostCaseBlock> — owner variant (all capabilities)", () => {
  const html = render(
    <LostCaseBlock
      pet={pet}
      photoUrl={null}
      episode={episode}
      scans={scans}
      ownerFirstName="Ana"
      alertsOriginShelter={false}
      isOwner={true}
      canManageDisclosure={true}
    />,
  );

  it("renders the urgent header with publicCode and public credential link", () => {
    expect(html).toContain("LOS-00042");
    expect(html).toContain("Credencial pública");
  });

  it("demotes the header to a quiet card head — the chrome band owns the red now (pet-state-header R7.2)", () => {
    // The seal→err gradient was the block's own red banner; with the masthead
    // band carrying the perdida state on BOTH faces, a second full-red header
    // inside the body duplicated the signal. The head is now a quiet tinted
    // strip — same content (avatar, name, case link, counts), no gradient.
    expect(html).not.toContain("linear-gradient(135deg, var(--color-ln-seal)");
    expect(html).toContain('data-section="lost-case-head"');
  });

  // Capability 2 (Marcar encontrada) is intentionally NOT asserted here
  // anymore — task #43 dedupe: the header no longer renders it, since
  // PetActionRow's identical always-visible icon (same
  // ?sheet=marcar-encontrada target) is the single surviving affordance.
  // Its 44px touch-target coverage lives in
  // __tests__/a11y-touch-targets.test.tsx's "PetActionRow" describe block.

  it("renders the actualizar last-seen link (capability 3 / 7)", () => {
    expect(html).toContain("actualizar");
    expect(html).toContain("/mis-mascotas/abc123/perdida");
  });

  it("renders the scans/sightings feed (capability 4, inside Más opciones)", () => {
    expect(html).toContain("Avistamientos y escaneos");
  });

  it("renders the disclosure toggles (capability 5, inside Más opciones)", () => {
    expect(html).toContain("Qué se muestra al público");
    expect(html).toContain("Tu nombre");
  });

  it("renders share + poster (capability 6, share-first hero)", () => {
    expect(html).toContain("Compartir por WhatsApp");
    expect(html).toContain("/mis-mascotas/abc123/cartel");
  });
});

describe("<LostCaseBlock> — org read-only variant (REQ-5.3)", () => {
  const html = render(
    <LostCaseBlock
      pet={pet}
      photoUrl={null}
      episode={episode}
      scans={scans}
      ownerFirstName="Ana"
      alertsOriginShelter={false}
      isOwner={false}
      canManageDisclosure={false}
    />,
  );

  it("still renders informational header + last-seen summary + scans feed", () => {
    expect(html).toContain("LOS-00042");
    expect(html).toContain("Plaza Italia");
    expect(html).toContain("Avistamientos y escaneos");
  });

  it("does NOT render Marcar encontrada", () => {
    expect(html).not.toContain("Marcar encontrado");
  });

  it("does NOT render the /perdida update link", () => {
    expect(html).not.toContain("/perdida");
    expect(html).not.toContain("actualizar");
  });

  it("does NOT render share/poster affordances", () => {
    expect(html).not.toContain("Compartir por WhatsApp");
    expect(html).not.toContain("/cartel");
  });

  it("does NOT render the disclosure toggles", () => {
    expect(html).not.toContain("Qué se muestra al público");
  });
});

// ---------------------------------------------------------------------------
// A CARETAKER on a lost pet — the exposure custodia-temporal opened.
//
// A caretaker is `accessPath === "owner"` (they hold a Path-1 ownership row),
// so `isOwner` is TRUE for them and they correctly get the owner variant of
// this block: marking the animal found is explicitly one of their allowed
// actions, and taking it away would be worse than the problem.
//
// But the owner variant also carries "Qué se muestra al público" — the
// TITULAR's own name, phone, email and last-known location. Before this change
// the caretaker role was unreachable in the UI, so nobody could flip somebody
// else's disclosure choices. Now they can be on this screen, and they must not.
//
// `canManageDisclosure` is REQUIRED, not defaulted: a prop that defaults to
// `true` fails open the day someone adds a second call site.
// ---------------------------------------------------------------------------
describe("LostCaseBlock — disclosure is the TITULAR's, even on a pet in someone else's care", () => {
  const base = {
    pet,
    photoUrl: null,
    episode,
    scans,
    ownerFirstName: "Ana",
    alertsOriginShelter: false,
    isOwner: true,
  };

  it("hides the disclosure controls from a caretaker", () => {
    const html = render(<LostCaseBlock {...base} canManageDisclosure={false} />);
    expect(html).not.toContain("Qué se muestra al público");
  });

  it("keeps 'Marcar como encontrada' for that same caretaker", () => {
    // NON-VACUITY, and the point of the narrow prop: hiding the disclosure card
    // must not cost the caretaker the one crisis action they exist for.
    const html = render(<LostCaseBlock {...base} canManageDisclosure={false} />);
    expect(html).toContain("encontrad");
  });

  it("still shows them to the legal owner", () => {
    const html = render(<LostCaseBlock {...base} canManageDisclosure={true} />);
    expect(html).toContain("Qué se muestra al público");
  });
});
