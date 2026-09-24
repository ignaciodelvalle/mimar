// Public case timeline redaction — caseTimelineSummary (cowork audit findings
// #2 and #9, 2026-08-12).
//
// WHAT THIS PROTECTS. /casos/[publicCode] is anonymously readable for
// lost_pet_episode and welfare_denuncia (canReadCase(null)). It used to render
// every event through eventPayloadSummary with no viewer distinction, so:
//
//   · the last-seen location of a lost pet reached anonymous viewers even when
//     the owner had turned the disclosure toggle OFF — while the credential
//     (/p/[publicToken]) honoured that same toggle. The owner sees the field
//     hidden where they set it, and has no reason to suspect a second surface
//     shows it. That "last seen" text is routinely the owner's home address.
//   · the free-text body of a cruelty complaint reached anonymous viewers.
//
// WHAT WOULD HAVE TO BREAK FOR THESE TO FAIL: the redaction itself. These
// assert on the returned summary of the real production function with real
// payload shapes — not on source text, and not on a reimplementation.

import { describe, expect, it } from "vitest";

import { caseTimelineSummary, eventPayloadSummary } from "@/lib/events/events";

const HOME_ADDRESS = "Av. Siempreviva 742, timbre 3B";
const COMPLAINT_TEXT = "El perro esta atado sin agua en el patio del fondo hace tres dias";

// Payload as set-pet-lost-use-case.ts writes it.
const lostPayload = {
  from_status: "active",
  to_status: "lost",
  location_description: HOME_ADDRESS,
  reason: "se escapo por el porton",
  disclosure_prefs_snapshot: {
    first_name: true,
    phone: true,
    email: false,
    last_location: false,
    finder_form: true,
  },
};

// Payload as update-lost-last-seen-use-case.ts writes it: NOT a second
// status_changed — a note_added(kind="sighting") whose `text` is composed as
// `${locationDescription} — ${reason}`.
const sightingNotePayload = {
  category: "otro",
  kind: "sighting",
  text: `${HOME_ADDRESS} — lo vieron cerca de la plaza`,
  location_description: HOME_ADDRESS,
};

const complaintPayload = {
  kind: "neglect",
  description: COMPLAINT_TEXT,
};

function renderedText(summary: { primary: string | null; secondary: string | null }): string {
  return [summary.primary, summary.secondary].filter(Boolean).join(" · ");
}

describe("caseTimelineSummary — anonymous viewer, disclosure OFF", () => {
  const opts = { isPublic: true, discloseLastLocation: false };

  it("does not emit the last-seen location of a lost pet", () => {
    const text = renderedText(caseTimelineSummary("status_changed", lostPayload, opts));

    expect(text).not.toContain(HOME_ADDRESS);
    expect(text).not.toContain("742");
  });

  it("still says the pet was marked lost — redaction hides the address, not the fact", () => {
    const summary = caseTimelineSummary("status_changed", lostPayload, opts);

    expect(summary.primary).toBe("Marcada como perdida");
  });

  it("does not emit the address through the note_added(kind=sighting) path either", () => {
    // The second vector: same address, different event type, and it lands in
    // `primary` rather than `secondary`. Redacting only status_changed would
    // leave this open.
    const text = renderedText(caseTimelineSummary("note_added", sightingNotePayload, opts));

    expect(text).not.toContain(HOME_ADDRESS);
    expect(text).not.toContain("742");
    // The entry must still read as something, not as a blank row.
    expect(text.length).toBeGreaterThan(0);
  });

  it("does not emit the body of a cruelty complaint", () => {
    for (const eventType of ["maltreatment_reported", "abandonment_reported"]) {
      const text = renderedText(caseTimelineSummary(eventType, complaintPayload, opts));

      expect(text).not.toContain(COMPLAINT_TEXT);
      expect(text).not.toContain("atado sin agua");
    }
  });

  it("leaves unrelated event types untouched", () => {
    const payload = { registry: "caba_4078" };

    expect(caseTimelineSummary("dangerous_breed_attested", payload, opts)).toEqual(
      eventPayloadSummary("dangerous_breed_attested", payload),
    );
  });
});

describe("caseTimelineSummary — anonymous viewer, disclosure ON", () => {
  const opts = { isPublic: true, discloseLastLocation: true };

  it("emits the last-seen location the owner chose to publish", () => {
    // The redaction must be driven by the preference, not by a blanket hide —
    // otherwise the lost-pet page stops doing its job for owners who WANT the
    // location out there.
    const text = renderedText(caseTimelineSummary("status_changed", lostPayload, opts));

    expect(text).toContain(HOME_ADDRESS);
  });

  it("emits the sighting note the owner chose to publish", () => {
    const text = renderedText(caseTimelineSummary("note_added", sightingNotePayload, opts));

    expect(text).toContain(HOME_ADDRESS);
  });

  it("still withholds complaint text — that redaction is not preference-driven", () => {
    const text = renderedText(caseTimelineSummary("maltreatment_reported", complaintPayload, opts));

    expect(text).not.toContain(COMPLAINT_TEXT);
  });
});

describe("caseTimelineSummary — authenticated (non-public) viewer", () => {
  it("is byte-identical to eventPayloadSummary for every case above", () => {
    // Operators, the owner and the reviewing authority lose nothing: the gate
    // is about ANONYMOUS readers of a shared CAS code.
    const cases: Array<[string, unknown]> = [
      ["status_changed", lostPayload],
      ["note_added", sightingNotePayload],
      ["maltreatment_reported", complaintPayload],
      ["abandonment_reported", complaintPayload],
    ];

    for (const [eventType, payload] of cases) {
      for (const discloseLastLocation of [true, false]) {
        expect(
          caseTimelineSummary(eventType, payload, { isPublic: false, discloseLastLocation }),
        ).toEqual(eventPayloadSummary(eventType, payload));
      }
    }
  });
});

describe("the redaction is driven by the CURRENT preference, not the payload snapshot", () => {
  it("hides the location even when the lost-time snapshot said last_location: true", () => {
    // An owner who publishes at lost-time and turns disclosure off later must
    // be honoured. Reading disclosure_prefs_snapshot out of the payload — the
    // obvious-looking fix — would keep showing the address forever, because the
    // spine is append-only and that snapshot can never change.
    const payloadWithPermissiveSnapshot = {
      ...lostPayload,
      disclosure_prefs_snapshot: {
        ...lostPayload.disclosure_prefs_snapshot,
        last_location: true,
      },
    };

    const text = renderedText(
      caseTimelineSummary("status_changed", payloadWithPermissiveSnapshot, {
        isPublic: true,
        discloseLastLocation: false,
      }),
    );

    expect(text).not.toContain(HOME_ADDRESS);
  });
});

describe("note_added es allow-list, no pattern-match (hallazgo #7 de la 2a pasada)", () => {
  const publicOpts = { isPublic: true, discloseLastLocation: true };

  // La nota que escribe create-org-welfare-report.ts cuando una segunda
  // organización denuncia al mismo animal. Va con caseId del caso original, que
  // es welfare_denuncia — legible por anónimos.
  const systemNotePayload = {
    category: "system",
    text: "Otra organización (Refugio Patitas del Sur) reportó un caso adicional sobre esta mascota. Ver caso CAS-9K2M-4TQX para el detalle.",
  };

  it("no emite el nombre de la organización denunciante", () => {
    const text = renderedText(caseTimelineSummary("note_added", systemNotePayload, publicOpts));

    expect(text).not.toContain("Refugio Patitas del Sur");
    expect(text).not.toContain("CAS-9K2M-4TQX");
  });

  it("deja la entrada visible en vez de un hueco mudo", () => {
    // Un timeline con filas vacías se lee como un bug de render.
    const summary = caseTimelineSummary("note_added", systemNotePayload, publicOpts);

    expect(summary.primary).toBe("Nota registrada en el caso");
  });

  it("una nota libre CUALQUIERA queda fuera por defecto, no sólo la de sistema", () => {
    // El punto del hallazgo no era esa nota: era que el default dejaba pasar
    // texto libre. Cualquier note_added futuro adjuntado a un caso anónimo tiene
    // que estar cerrado de entrada.
    const arbitrary = { category: "otro", text: "El vecino de la esquina, Juan Pérez, dice que…" };
    const text = renderedText(caseTimelineSummary("note_added", arbitrary, publicOpts));

    expect(text).not.toContain("Juan Pérez");
  });

  it("el viewer autenticado sigue viendo la nota completa", () => {
    expect(
      caseTimelineSummary("note_added", systemNotePayload, {
        isPublic: false,
        discloseLastLocation: false,
      }),
    ).toEqual(eventPayloadSummary("note_added", systemNotePayload));
  });
});
