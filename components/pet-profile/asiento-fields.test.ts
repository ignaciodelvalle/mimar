// Purity / determinism tests for the libreta asiento relative-time renderer.
//
// The credential/libreta hydration-freeze residual (F1 `now`-subclass): a
// relative-time renderer that computes `now` at render produces a different
// label on a second evaluation once wall-clock drifts, which — for a value
// that must match between the server render and the client hydration render —
// is a hydration mismatch. The systemic fix threads a SINGLE mount-stable
// `now` (LibretaFace) into every call. These tests lock in the property that
// makes that fix sound: given a FIXED `now`, the label is a pure, stable
// function of (date, now) with no hidden dependency on the ambient clock.

import type { HistorialEventRow } from "@/src/modules/pets/application/tab-data/types";
import { describe, expect, it } from "vitest";
import { type AsientoViewer, formatRelative, toAsientoView } from "./asiento-fields";

const NOW = new Date("2026-07-04T12:00:00Z");

// Transfer cast (staging validation 2026-08-01, bug 1). GRACIELA loaded a
// rabies dose, then transferred the pet to NOELI. Every fixture below now
// STATES who wrote the row and who is reading it, because the defect was
// precisely that neither was stated and the projection guessed from the
// author's role.
const GRACIELA = "user-graciela";
const NOELI = "user-noeli";
const VET_USER = "user-vet";

/** The ordinary case: the reader is the titular and wrote the asiento. */
const SELF: AsientoViewer = { userId: GRACIELA, currentOwnerUserId: GRACIELA };
/** After the transfer: NOELI reads a libreta GRACIELA wrote entries in. */
const NEW_OWNER: AsientoViewer = { userId: NOELI, currentOwnerUserId: NOELI };

describe("formatRelative — pure given a fixed now", () => {
  it("is deterministic: same (date, now) yields the same label across calls", () => {
    const date = new Date("2026-06-20T12:00:00Z");
    const a = formatRelative(date, NOW);
    const b = formatRelative(date, NOW);
    expect(a).toBe(b);
  });

  it("does not read the ambient wall clock (advancing real time changes nothing)", () => {
    const date = new Date("2026-07-01T12:00:00Z");
    const first = formatRelative(date, NOW);
    // Simulate time passing between two renders that share the SAME frozen now.
    const laterCallSameNow = formatRelative(date, NOW);
    expect(laterCallSameNow).toBe(first);
  });

  it("buckets the elapsed span correctly", () => {
    expect(formatRelative(new Date("2026-07-04T09:00:00Z"), NOW)).toBe("hoy");
    expect(formatRelative(new Date("2026-07-03T09:00:00Z"), NOW)).toBe("ayer");
    expect(formatRelative(new Date("2026-07-01T12:00:00Z"), NOW)).toBe("hace 3 días");
    expect(formatRelative(new Date("2026-06-25T12:00:00Z"), NOW)).toBe("hace 1 semana");
    expect(formatRelative(new Date("2026-06-04T12:00:00Z"), NOW)).toBe("hace 1 mes");
    expect(formatRelative(new Date("2025-07-04T12:00:00Z"), NOW)).toBe("hace 1 año");
  });

  it("a value straddling a day boundary is stable when now is frozen", () => {
    // ~47h before now = 10:00 AR two calendar days back. The old elapsed
    // floor(47/24)=1 called this "ayer" — WRONG: "ayer" is a calendar word,
    // and this date is the day BEFORE yesterday in Argentina. Calendar-day
    // semantics (calendarDaysAgoInAr) say "hace 2 días". The determinism
    // property (frozen now → stable label) is unchanged.
    const date = new Date("2026-07-02T13:00:00Z");
    expect(formatRelative(date, NOW)).toBe(formatRelative(date, NOW));
    expect(formatRelative(date, NOW)).toBe("hace 2 días");
  });

  it("counts calendar days in AR, not 24h blocks (the libreta 'hoy' repro)", () => {
    // 20:00 AR yesterday viewed at 09:00 AR today is only 13 elapsed hours —
    // the old floor(elapsed/24h)=0 labeled it "hoy". It happened AYER.
    const yesterdayEvening = new Date("2026-07-03T23:00:00Z"); // 20:00 AR 07-03
    expect(formatRelative(yesterdayEvening, NOW)).toBe("ayer");
  });
});

describe("toAsientoView — whenRelative is deterministic under a fixed now", () => {
  const row: HistorialEventRow = {
    id: "evt-1",
    petId: "pet-1",
    eventType: "weight_recorded",
    payload: { kg: "12.4" },
    occurredAt: new Date("2026-07-01T12:00:00Z"),
    notes: null,
    recordedByUserId: GRACIELA,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  it("produces the same whenRelative for the same now across calls", () => {
    const a = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    const b = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    expect(a.whenRelative).toBe(b.whenRelative);
    expect(a.whenRelative).toBe("hace 3 días");
  });
});

// ---------------------------------------------------------------------------
// "Aplicó" attribution — must never contradict the provenance stamp
// (staging validation 2026-07-04, bug 1: vet-signed vaccine read "Declarado
// por el titular" next to a "Verificado por vet" badge).
// ---------------------------------------------------------------------------

describe("toAsientoView — vaccine 'Aplicó' attribution is consistent with the signature", () => {
  const baseVaccine: HistorialEventRow = {
    id: "evt-vac",
    petId: "pet-1",
    eventType: "vaccination_administered",
    payload: { vaccine_name: "Antirrábica" },
    occurredAt: new Date("2026-07-01T12:00:00Z"),
    notes: null,
    recordedByUserId: GRACIELA,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  function aplicoOf(row: HistorialEventRow): { value: string; missing?: boolean } {
    const view = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    const f = view.facts.find((x) => x.key === "Aplicó");
    if (!f) throw new Error("missing Aplicó fact");
    return f;
  }

  it("vet-signed without administered_by never says 'Declarado por el titular'", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: "org-1",
      authorOrgName: "Clínica San Roque",
      recordedByUserId: VET_USER,
    };
    const view = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.verified).toBe(true);
    const aplico = aplicoOf(row);
    expect(aplico.value).not.toContain("Declarado por el titular");
    expect(aplico.value).toBe("Vet. matriculado/a — Clínica San Roque");
    expect(aplico.missing).toBe(false);
    // A verified record must not carry the "falta verificación" warning.
    expect(view.warn).toBeUndefined();
  });

  it("vet-signed with a stamped matrícula attributes 'Vet. M.N. XXX'", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: "org-1",
      authorOrgName: "Clínica San Roque",
      vetMatricula: "4821",
    };
    expect(aplicoOf(row).value).toBe("Vet. M.N. 4821");
  });

  it("vet-signed with no org name still attributes the verified signature", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: "org-1",
    };
    expect(aplicoOf(row).value).toBe("Vet. matriculado/a (firma verificada)");
  });

  it("org-recorded (no matrícula) attributes the organization, not the titular", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      authorRole: "shelter",
      authorVerified: false,
      authorOrganizationId: "org-1",
      authorOrgName: "Refugio Esperanza",
    };
    const aplico = aplicoOf(row);
    expect(aplico.value).toBe("Refugio Esperanza");
    expect(aplico.missing).toBe(false);
  });

  it("explicit administered_by always wins over the signer fallback", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      payload: { vaccine_name: "Antirrábica", administered_by: "Dra. Paz — MP 4821" },
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: "org-1",
      authorOrgName: "Clínica San Roque",
    };
    expect(aplicoOf(row).value).toBe("Dra. Paz — MP 4821");
  });

  it("owner-declared keeps 'Declarado por el titular' (correct in that case)", () => {
    const aplico = aplicoOf(baseVaccine);
    expect(aplico.value).toBe("Declarado por el titular");
    expect(aplico.missing).toBe(true);
  });

  it("lab-confirmed owner dose stays owner-attributed (tier bumper must not fake a signer)", () => {
    const row: HistorialEventRow = {
      ...baseVaccine,
      payload: { vaccine_name: "Antirrábica", confirmed_by_lab: true },
    };
    expect(aplicoOf(row).value).toBe("Declarado por el titular");
  });
});

// ---------------------------------------------------------------------------
// Sighting attribution — a third-party /p report is NOT an owner note
// (QA A4: a sighting loaded from the public page rendered "NOTA · CARGADO POR
// VOS" in the owner's own libreta, misattributing a stranger's report to the
// titular). A sighting is note_added, kind="sighting", authorRole="scanner".
// ---------------------------------------------------------------------------

describe("toAsientoView — sighting note is attributed to a third party, not the owner", () => {
  const baseSighting: HistorialEventRow = {
    id: "evt-sighting",
    petId: "pet-1",
    eventType: "note_added",
    payload: { category: "otro", kind: "sighting", text: "La vi cerca de la plaza." },
    occurredAt: new Date("2026-07-02T12:00:00Z"),
    notes: null,
    // An anonymous QR scan has no signed-in author at all.
    recordedByUserId: null,
    authorRole: "scanner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  it("never reads 'Cargado por vos' for a scanner-authored sighting", () => {
    const view = toAsientoView(baseSighting, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.verified).toBe(false);
    expect(view.provenance.label).toBe("Reportado por un tercero");
    expect(view.provenance.label).not.toBe("Cargado por vos");
  });

  it("uses an 'Avistaje' eyebrow, not 'Nota'", () => {
    const view = toAsientoView(baseSighting, "TOKEN-1234", SELF, NOW);
    expect(view.kind).toBe("Avistaje");
    expect(view.handwrittenNote).toBe("La vi cerca de la plaza.");
  });

  it("names the finder in the title when the sighting carries one", () => {
    const row: HistorialEventRow = {
      ...baseSighting,
      payload: { ...(baseSighting.payload as object), finderName: "Vecina del 3B" },
    };
    const view = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    expect(view.title).toBe("Avistaje · Vecina del 3B");
  });

  // Renamed (2026-08-01). The old name — "still renders an ordinary owner note
  // as 'Nota · Cargado por vos'" — treated "authored by an owner" and "authored
  // by YOU" as the same fact. They are not, and that conflation is exactly the
  // defect: the fixture never said who wrote the note, so the assertion passed
  // no matter who was reading.
  it("an owner note written by THE READER reads 'Cargado por vos'", () => {
    const row: HistorialEventRow = {
      ...baseSighting,
      payload: { category: "recordatorio", text: "Cumple hoy." },
      authorRole: "owner",
      recordedByUserId: GRACIELA,
    };
    const view = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    expect(view.kind).toBe("Nota");
    expect(view.provenance.label).toBe("Cargado por vos");
  });
});

// ---------------------------------------------------------------------------
// WHO surfacing (C5, 2026-07-21 facades harvest): the org_registered
// provenance stamp previously read the generic "Registrado por la
// organización" for EVERY org-authored, non-professional-signed record —
// unlike the operator ledger (EventLedgerRow), which always names the actor.
// The loader already resolves authorOrgName (used by the vaccine "Aplicó"
// field); the provenance stamp now names the org too when it's available,
// never a personal staffer name (org identity isn't PII the way a person's
// name is).
// ---------------------------------------------------------------------------

describe("deriveProvenance — org_registered names the organization (C5)", () => {
  const baseDeworming: HistorialEventRow = {
    id: "evt-dw-1",
    petId: "pet-1",
    eventType: "deworming_administered",
    payload: { product: "Drontal", type: "internal" },
    occurredAt: new Date("2026-07-02T12:00:00Z"),
    notes: null,
    recordedByUserId: "user-shelter-staffer",
    authorRole: "shelter",
    authorVerified: false,
    authorOrganizationId: "org-1",
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  it("names the organization when the loader resolved authorOrgName", () => {
    const row: HistorialEventRow = { ...baseDeworming, authorOrgName: "Refugio Esperanza" };
    const view = toAsientoView(row, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.label).toBe("Registrado por Refugio Esperanza");
    expect(view.provenance.verified).toBe(false);
  });

  it("falls back to the generic label when authorOrgName is absent", () => {
    const view = toAsientoView(baseDeworming, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.label).toBe("Registrado por la organización");
  });
});

// ---------------------------------------------------------------------------
// TRANSFER PROVENANCE (staging validation 2026-08-01, bug 1 — the worst of the
// batch). graciela loaded a rabies dose, then transferred the pet to noeli. In
// noeli's libreta that dose was stamped "Cargado por vos".
//
// The product's whole argument is traceability. A libreta that reassigns
// authorship to whoever holds the pet today is not a ledger — it is a document
// that rewrites itself on every change of hands. The spine records
// `recorded_by_user_id`, so the correct answer was always available; the
// projection simply never asked, and inferred "vos" from the author's ROLE.
// ---------------------------------------------------------------------------

describe("toAsientoView — authorship survives a transfer", () => {
  const gracielasVaccine: HistorialEventRow = {
    id: "evt-vac-graciela",
    petId: "pet-1",
    eventType: "vaccination_administered",
    payload: { vaccine_name: "Antirrábica" },
    occurredAt: new Date("2026-07-01T12:00:00Z"),
    notes: null,
    recordedByUserId: GRACIELA,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  it("THE REGRESSION: the new titular never sees the previous titular's dose as her own", () => {
    const view = toAsientoView(gracielasVaccine, "TOKEN-1234", NEW_OWNER, NOW);
    expect(view.provenance.label).not.toBe("Cargado por vos");
    expect(view.provenance.label).not.toContain("vos");
    expect(view.provenance.label).toBe("Cargado por el titular anterior");
  });

  it("the author herself still reads 'Cargado por vos' — the fix must not flatten everyone", () => {
    const view = toAsientoView(gracielasVaccine, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.label).toBe("Cargado por vos");
  });

  it("an org/vet viewer is never 'vos' either, even on the CURRENT titular's own entry", () => {
    // The same libreta read by a clinic: the author IS the current titular, but
    // the reader is not. Before the fix every owner-declared row told the vet
    // "Cargado por vos".
    const vetViewer: AsientoViewer = { userId: VET_USER, currentOwnerUserId: GRACIELA };
    const view = toAsientoView(gracielasVaccine, "TOKEN-1234", vetViewer, NOW);
    expect(view.provenance.label).toBe("Cargado por el titular");
  });

  it("a legacy row with no recorded author never claims the reader wrote it", () => {
    const legacy: HistorialEventRow = { ...gracielasVaccine, recordedByUserId: null };
    const view = toAsientoView(legacy, "TOKEN-1234", NEW_OWNER, NOW);
    expect(view.provenance.label).toBe("Cargado por el titular");
    expect(view.provenance.label).not.toContain("vos");
  });

  it("the cited-professional wording follows the same subject, conjugated", () => {
    const cited: HistorialEventRow = {
      ...gracielasVaccine,
      payload: { vaccine_name: "Antirrábica", administered_by: "Dra. Paz — MP 4821" },
    };
    expect(toAsientoView(cited, "TOKEN-1234", SELF, NOW).provenance.label).toBe(
      "Declarado por vos — citás a Dra. Paz — MP 4821",
    );
    // Voseo does not survive a third-person subject: "el titular anterior citás"
    // is not Spanish.
    expect(toAsientoView(cited, "TOKEN-1234", NEW_OWNER, NOW).provenance.label).toBe(
      "Declarado por el titular anterior — cita a Dra. Paz — MP 4821",
    );
  });

  it("a verified vet signature is unaffected by who is reading", () => {
    const vetSigned: HistorialEventRow = {
      ...gracielasVaccine,
      authorRole: "vet",
      authorVerified: true,
      authorOrganizationId: "org-1",
      recordedByUserId: VET_USER,
    };
    for (const viewer of [SELF, NEW_OWNER]) {
      const view = toAsientoView(vetSigned, "TOKEN-1234", viewer, NOW);
      expect(view.provenance.verified).toBe(true);
      expect(view.provenance.label).toBe("Verificado por vet");
    }
  });
});

// ---------------------------------------------------------------------------
// The same defect class on the roles that fell through to the owner branch.
// `finder`, `system`, and an UNVERIFIED vet/govt all reached the final
// `return { label: "Cargado por vos" }` — three more stamps that put words in
// the reader's mouth.
// ---------------------------------------------------------------------------

describe("toAsientoView — non-owner roles never borrow the titular's voice", () => {
  const base: HistorialEventRow = {
    id: "evt-x",
    petId: "pet-1",
    eventType: "note_added",
    payload: { category: "otro", text: "Algo pasó." },
    occurredAt: new Date("2026-07-02T12:00:00Z"),
    notes: null,
    recordedByUserId: "user-someone-else",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };

  it("a finder's report reads as a third party, not as the titular", () => {
    const view = toAsientoView({ ...base, authorRole: "finder" }, "TOKEN-1234", SELF, NOW);
    expect(view.provenance.label).toBe("Reportado por un tercero");
  });

  it("a system-written row is not a declaration by anyone", () => {
    const view = toAsientoView(
      { ...base, authorRole: "system", recordedByUserId: null },
      "TOKEN-1234",
      SELF,
      NOW,
    );
    expect(view.provenance.label).toBe("Registrado automáticamente");
  });

  it("an UNVERIFIED vet is neither verification nor an owner declaration", () => {
    const view = toAsientoView(
      { ...base, authorRole: "vet", authorVerified: false, recordedByUserId: VET_USER },
      "TOKEN-1234",
      SELF,
      NOW,
    );
    expect(view.provenance.verified).toBe(false);
    expect(view.provenance.label).toBe("Registrado sin verificar");
    expect(view.provenance.label).not.toContain("vos");
  });
});
