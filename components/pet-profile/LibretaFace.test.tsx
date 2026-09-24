// Tests for <LibretaFace> — pet profile two-face redesign (Face 2, 2026-07-01).
//
// Covers the H3 negative case end-to-end through the real component tree
// (LibretaFace → EventTimelineList → eventPayloadDetails): raw/blacklisted
// payload keys (hashes, internal ids, matched_chip_number) must never reach
// the DOM, even when present on the event payload. The whitelist function
// itself is exhaustively unit-tested in __tests__/event-payload-details.test.ts;
// this closes the remaining gap of asserting the guarantee holds once wired
// into the Libreta face lens/row rendering (task 5.5). Render via
// react-dom/server (same pattern as PetAlertStrip.test.tsx / CredentialFace.test.tsx).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  HistorialEventRow,
  LibretaFaceData,
} from "@/src/modules/pets/application/tab-data/types";
import { LibretaFace } from "./LibretaFace";

const SECRET_HASH = "SECRET_FIRMA_HASH_9f2c";
const SECRET_CHIP = "SECRET_MATCHED_CHIP_777";
const SECRET_INTERNAL_ID = "SECRET_INTERNAL_ROW_ID";
const OWNER_USER = "user-owner";
const VET_USER = "user-vet";

function pastEvent(overrides: Partial<HistorialEventRow> = {}): HistorialEventRow {
  return {
    id: "evt-1",
    petId: "pet-1",
    eventType: "sterilization_performed",
    // Payload mixes whitelisted fields (procedure/performed_by/clinic) with
    // fields that must NEVER be surfaced (hash, internal id, matched chip).
    payload: {
      procedure: "castration",
      performed_by: "Dr. Perez",
      clinic: "Vet Palermo",
      firma_hash: SECRET_HASH,
      matched_chip_number: SECRET_CHIP,
      internal_ref_id: SECRET_INTERNAL_ID,
    },
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    notes: null,
    recordedByUserId: VET_USER,
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
    ...overrides,
  };
}

function faceData(overrides: Partial<LibretaFaceData> = {}): LibretaFaceData {
  return {
    identity: {
      name: "Firulais",
      species: "dog",
      breed: "Mestizo",
      sex: "male",
      microchipId: null,
      tattooCode: null,
      tattooLocation: null,
      publicToken: "abc",
    },
    future: [],
    past: [pastEvent()],
    pastTruncated: false,
    summary: {
      active: 0,
      dueSoon: 0,
      expired: 0,
      missing: 0,
      unconfirmed: 0,
      otherCount: 0,
      perVaccine: [],
    },
    weightSamples: [],
    activeShares: [],
    accessPath: "owner",
    viewer: { userId: OWNER_USER, currentOwnerUserId: OWNER_USER },
    ...overrides,
  };
}

describe("LibretaFace — H3 curated detail (negative case, end-to-end)", () => {
  it("never renders raw/blacklisted payload keys for the owner audience", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData()} petPublicToken="abc" isOwner />,
    );

    // Whitelisted fields DO render — proves the row isn't just empty.
    expect(html).toContain("Dr. Perez");
    expect(html).toContain("Vet Palermo");

    // Blacklisted fields must never reach the DOM.
    expect(html).not.toContain(SECRET_HASH);
    expect(html).not.toContain(SECRET_CHIP);
    expect(html).not.toContain(SECRET_INTERNAL_ID);
    expect(html).not.toContain("firma_hash");
    expect(html).not.toContain("matched_chip_number");
    expect(html).not.toContain("internal_ref_id");
  });
});

describe("LibretaFace — ADR-10 consolidation (no lens chips, share removed)", () => {
  it("owner sees the note_added event too (no chip filtering, single consolidated timeline)", () => {
    const noteEvent = pastEvent({
      id: "evt-note",
      eventType: "note_added",
      payload: { text: "OWNER-ONLY-NOTE-MARKER" },
    });
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData({ past: [noteEvent] })} petPublicToken="abc" isOwner />,
    );
    expect(html).toContain("OWNER-ONLY-NOTE-MARKER");
  });

  it("org viewer never sees a non-libreta-sanitaria event (note_added filtered out)", () => {
    const noteEvent = pastEvent({
      id: "evt-note",
      eventType: "note_added",
      payload: { text: "OWNER-ONLY-NOTE-MARKER" },
    });
    const html = renderToStaticMarkup(
      <LibretaFace
        data={faceData({ past: [noteEvent], accessPath: "org" })}
        petPublicToken="abc"
        isOwner={false}
      />,
    );
    expect(html).not.toContain("OWNER-ONLY-NOTE-MARKER");
  });

  it("renders no lens-chip UI (no 'Todo'/'Vacunas'/'Oficial' toggle buttons)", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData()} petPublicToken="abc" isOwner />,
    );
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).not.toContain('aria-pressed="false"');
  });

  it("no longer renders SharesManager or the footer 'Compartir libreta' link (ADR-14)", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData()} petPublicToken="abc" isOwner />,
    );
    expect(html).not.toContain("Compartir libreta");
    expect(html).not.toContain("Nuevo enlace");
  });

  it("still renders ExportLibretaButton in the footer with honest print-to-PDF copy", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData()} petPublicToken="abc" isOwner />,
    );
    // "Imprimir" (not "Exportar") — the route has no server-side PDF
    // generation, it opens a print-styled HTML view that auto-triggers
    // window.print(); the label must not claim a real export.
    expect(html).toContain("Imprimir libreta (PDF)");
    expect(html).not.toContain("Exportar libreta (PDF)");
  });

  it("VacunasStatusBadges renders unconditionally (org viewer too — always-on, ADR-10)", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData({ accessPath: "org" })} petPublicToken="abc" isOwner={false} />,
    );
    expect(html).toContain("Estado de vacunación");
  });
});

// wave-3 P3 (PO decision #645 point 3): Emergencia moved off CredentialFace
// into a compact owner-only block near this face's footer, above the
// immutability note.
describe("LibretaFace — Emergencia block (wave-3 P3)", () => {
  it("renders nothing when emergencyContacts is omitted (org viewers never receive it)", () => {
    const html = renderToStaticMarkup(
      <LibretaFace data={faceData()} petPublicToken="abc" isOwner />,
    );
    expect(html).not.toContain("Emergencia");
    expect(html).not.toContain("libreta-emergencia");
  });

  it("renders vet + contact rows with tel: links and the vet name when set", () => {
    const html = renderToStaticMarkup(
      <LibretaFace
        data={faceData()}
        petPublicToken="abc"
        isOwner
        emergencyContacts={{
          vet: { name: "Dra. Pérez", phone: "1122334455", source: "pet" },
          emergency: { name: "Ana", phone: "1166778899", source: "pet" },
        }}
      />,
    );
    expect(html).toContain('data-section="libreta-emergencia"');
    expect(html).toContain("Emergencia");
    expect(html).toContain('href="tel:1122334455"');
    expect(html).toContain('href="tel:1166778899"');
    // owner-ia-redesign P2: the preferred vet NAME now renders (was fetched-but-unused).
    expect(html).toContain("Dra. Pérez");
    expect(html).toContain("Ana");
    expect(html).toContain("Editar →");
    // Both rows come from the pet override — no account-fallback tag.
    expect(html).not.toContain("(de tu cuenta)");
  });

  it("tags a row that fell back to the account default as '(de tu cuenta)'", () => {
    const html = renderToStaticMarkup(
      <LibretaFace
        data={faceData()}
        petPublicToken="abc"
        isOwner
        emergencyContacts={{
          vet: { name: "Dr. Cuenta", phone: "1100000000", source: "account" },
          emergency: null,
        }}
      />,
    );
    expect(html).toContain("Dr. Cuenta");
    expect(html).toContain("(de tu cuenta)");
    expect(html).toContain("Editar →");
  });

  it("shows the add-data prompt and opens ?sheet=emergencia when neither level has data", () => {
    const html = renderToStaticMarkup(
      <LibretaFace
        data={faceData()}
        petPublicToken="abc"
        isOwner
        emergencyContacts={{ vet: null, emergency: null }}
      />,
    );
    expect(html).toContain("Agregar datos de emergencia →");
    expect(html).toContain('href="/mis-mascotas/abc?sheet=emergencia"');
  });

  it("appears above the immutability note, near the footer", () => {
    const html = renderToStaticMarkup(
      <LibretaFace
        data={faceData()}
        petPublicToken="abc"
        isOwner
        emergencyContacts={{
          vet: { name: "Dra. Pérez", phone: "1122334455", source: "pet" },
          emergency: { name: "Ana", phone: "1166778899", source: "pet" },
        }}
      />,
    );
    const emergenciaPos = html.indexOf('data-section="libreta-emergencia"');
    const notePos = html.indexOf("Los eventos no se editan ni se borran");
    expect(emergenciaPos).toBeGreaterThan(-1);
    expect(notePos).toBeGreaterThan(emergenciaPos);
  });
});
