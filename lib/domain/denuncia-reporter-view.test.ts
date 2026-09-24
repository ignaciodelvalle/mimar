// The reporter's entitlement, pinned.
//
// This is the legal boundary of change `legal/denuncias-despublicadas` expressed
// as assertions. The reporter is entitled to their own submission and a coarse
// status timeline; they are NOT entitled to the identity of the accused, internal
// notes, the substantive content of the investigation, or the grounds of any
// resolution, because they are not a party to the proceeding.
//
// METHOD. Every case drives the projection with a HOSTILE row: a report carrying
// a real-looking description of the accused, resolution notes, coordinates, a
// street address, moderation flags and operator ids. Then it serializes the
// output and asserts none of those values are anywhere in it. A negative
// assertion against an empty fixture proves nothing, so the fixture is populated
// on every field the boundary is supposed to stop — and the non-vacuity case
// below proves the fixture's poison is real by finding it in the INPUT.

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_IN_REPORTER_VIEW,
  buildReporterTimeline,
  buildReporterView,
} from "./denuncia-reporter-view";

// Distinctive, greppable poison values.
const ACCUSED_DESCRIPTION = "hombre de unos sesenta, galpon de chapa sobre la ruta 8";
const RESOLUTION_NOTES = "se archiva por falta de merito tras inspeccion del 12/3";
const STREET_ADDRESS = "Ruta 8 km 41, casa con reja verde";
const LAT = "-34.6037220";
const LNG = "-58.3815920";
const OWN_TEXT = "Vi tres perros sin agua atados al sol todo el dia.";
const REPORTER_EMAIL = "denunciante@example.com";
const REPORTER_PHONE = "+5491133445566";
const CASE_ID = "11111111-2222-3333-4444-555555555555";
const REPORT_ID = "99999999-8888-7777-6666-555555555555";
const OPERATOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const SUBMITTED = new Date("2026-03-01T10:00:00Z");
const DERIVED = new Date("2026-03-03T10:00:00Z");
const TRIAGED = new Date("2026-03-05T10:00:00Z");
const CLOSED = new Date("2026-03-20T10:00:00Z");

/**
 * A row shaped like the real `welfare_reports` select — including every column
 * the projection must refuse. Typed loosely on purpose: the point is to hand
 * buildReporterView MORE than its declared source type, exactly as a
 * `select()`-the-whole-row call site would, and prove the extra fields do not
 * ride along.
 */
function hostileRow(overrides: Record<string, unknown> = {}) {
  return {
    // Entitled
    referenceCode: "DEN-ABCD-EFGH",
    createdAt: SUBMITTED,
    occurredAt: new Date("2026-02-27T18:30:00Z"),
    kind: "maltrato",
    severity: "high",
    description: OWN_TEXT,
    reporterContactEmail: REPORTER_EMAIL,
    reporterContactPhone: REPORTER_PHONE,
    status: "invalid",
    triagedAt: TRIAGED,
    derivedAt: DERIVED,
    closedAt: CLOSED,
    // Everything below must never surface
    id: REPORT_ID,
    subjectDescription: ACCUSED_DESCRIPTION,
    subjectPetId: "77777777-7777-7777-7777-777777777777",
    resolutionNotes: RESOLUTION_NOTES,
    locationAddress: STREET_ADDRESS,
    locationLat: LAT,
    locationLng: LNG,
    localityId: "66666666-6666-6666-6666-666666666666",
    caseId: CASE_ID,
    assignedToUserId: OPERATOR_ID,
    triagedByUserId: OPERATOR_ID,
    derivedByUserId: OPERATOR_ID,
    flagReasons: ["duplicate_text", "no_contact"],
    flaggedAt: new Date("2026-03-02T10:00:00Z"),
    moderationResolvedAt: new Date("2026-03-04T10:00:00Z"),
    moderationResolvedByUserId: OPERATOR_ID,
    moderationEscalatedAt: new Date("2026-03-04T12:00:00Z"),
    moderationEscalatedByUserId: OPERATOR_ID,
    jurisdictionUnverified: true,
    seedTag: "panorama",
    ...overrides,
  };
}

const FORBIDDEN_VALUES = [
  ACCUSED_DESCRIPTION,
  RESOLUTION_NOTES,
  STREET_ADDRESS,
  LAT,
  LNG,
  CASE_ID,
  REPORT_ID,
  OPERATOR_ID,
  "duplicate_text",
  "panorama",
];

describe("buildReporterView — what the denunciante is NOT entitled to", () => {
  it("never emits the identity of the accused, internal notes, coordinates, or the resolution grounds", () => {
    const view = buildReporterView(hostileRow(), {
      attachmentCount: 3,
      organism: { name: "Municipalidad de Test", email: "bienestar@test.gob.ar", phone: null },
    });
    const serialized = JSON.stringify(view);

    for (const poison of FORBIDDEN_VALUES) {
      expect(
        serialized,
        `"${poison}" reached the reporter view — the projection is leaking a field the denunciante is not entitled to`,
      ).not.toContain(poison);
    }
  });

  it("emits no key named after a forbidden column, whatever its value", () => {
    // Values can coincide; key names cannot. This catches the `...report` spread
    // that FORBIDDEN_IN_REPORTER_VIEW exists to prevent, even if a future fixture
    // happens to null the poison out.
    const view = buildReporterView(hostileRow(), { attachmentCount: 0, organism: null });
    const keys = new Set(Object.keys(view));
    for (const forbidden of FORBIDDEN_IN_REPORTER_VIEW) {
      expect(keys.has(forbidden), `reporter view exposes forbidden key "${forbidden}"`).toBe(false);
    }
  });

  it("NON-VACUITY: the fixture really does carry the poison, so the assertions above have something to stop", () => {
    // Without this, every negative assertion above would pass just as happily
    // against an empty row — a completely different security posture from a
    // populated row that was filtered. Prove the input is loaded.
    const serializedInput = JSON.stringify(hostileRow());
    for (const poison of FORBIDDEN_VALUES) {
      expect(
        serializedInput,
        `the hostile fixture lost "${poison}" — the boundary tests have gone inert`,
      ).toContain(poison);
    }
  });

  it("FORBIDDEN_IN_REPORTER_VIEW still names the fields the legal review singled out", () => {
    // Shortening the list is how this contract would quietly weaken, so the
    // legally-decisive entries are pinned by name rather than by count.
    for (const required of [
      "subjectDescription",
      "resolutionNotes",
      "locationAddress",
      "locationLat",
      "locationLng",
      "caseId",
      "status",
    ]) {
      expect(FORBIDDEN_IN_REPORTER_VIEW).toContain(required);
    }
  });
});

describe("buildReporterView — what the denunciante IS entitled to", () => {
  it("returns their own text verbatim, the constancia number, and the contact retained in full", () => {
    const view = buildReporterView(hostileRow(), {
      attachmentCount: 2,
      organism: { name: "Refugio Test", email: "hola@refugio.test", phone: "+541199887766" },
    });

    expect(view.ownText).toBe(OWN_TEXT);
    expect(view.constanciaNumber).toBe("DEN-ABCD-EFGH");
    expect(view.submittedAt.getTime()).toBe(SUBMITTED.getTime());
    // Ley 25.326 access answer: the contact is shown WHOLE, not masked. The old
    // public receipt masked it because any code holder could read the screen;
    // here the reader has proven control of the channel, and half a datum
    // answers nothing.
    expect(view.retainedContact.email).toBe(REPORTER_EMAIL);
    expect(view.retainedContact.phone).toBe(REPORTER_PHONE);
    expect(view.attachmentCount).toBe(2);
    expect(view.organism?.name).toBe("Refugio Test");
  });

  it("reports an anonymous submission as retaining nothing rather than as missing data", () => {
    const view = buildReporterView(
      hostileRow({ reporterContactEmail: null, reporterContactPhone: null }),
      { attachmentCount: 0, organism: null },
    );
    expect(view.retainedContact).toEqual({ email: null, phone: null });
  });
});

describe("buildReporterTimeline", () => {
  it("coarsens every terminal status to 'cerrada' — 'invalid' never surfaces as 'sin sustento'", () => {
    // `invalid`/`duplicate` are resolution GROUNDS wearing an enum's clothes.
    // Handing "Sin sustento" to someone who reported in good faith would breach
    // the entitlement AND discourage the next report.
    for (const status of ["closed", "invalid", "duplicate"]) {
      const timeline = buildReporterTimeline(hostileRow({ status }));
      const stages = timeline.map((e) => e.stage);
      expect(stages).toContain("cerrada");
      expect(JSON.stringify(timeline)).not.toContain(status);
    }
  });

  it("emits only stages whose timestamp exists, in chronological order", () => {
    const timeline = buildReporterTimeline(hostileRow());
    expect(timeline.map((e) => e.stage)).toEqual(["recibida", "derivada", "en_tramite", "cerrada"]);
    const times = timeline.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("a brand-new report has exactly one stage — the timeline never asserts a step it cannot date", () => {
    const timeline = buildReporterTimeline(
      hostileRow({ status: "open", triagedAt: null, derivedAt: null, closedAt: null }),
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].stage).toBe("recibida");
  });
});
