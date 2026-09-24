import type { EventAttachmentV1, EventFactV1 } from "@dim/contract/api";
import { describe, expect, it } from "@jest/globals";

import {
  AMEND_NO_CURATED_FACTS_NOTE,
  AMEND_NO_EDITABLE_FACTS_NOTE,
  AMEND_READ_ONLY_NOTE,
  ATTACHMENT_UNAVAILABLE_LABEL,
  amendNoEditableFactsNote,
  amendRequiredFactMessage,
  amendableFacts,
  amendmentChangeLine,
  amendmentHeadline,
  attachmentExpired,
  attachmentExpiryLabel,
  authorLine,
  buildAmendChanges,
  buildAmendEventCommand,
  clearedRequiredFact,
  initialAmendEdits,
  isPassThroughFact,
  isRequiredFact,
  readOnlyFacts,
} from "./event-detail-view-model";

const NOW = new Date("2026-08-25T15:00:00Z");

function fact(field: string, label: string, value: string): EventFactV1 {
  return { field, label, value };
}

function attachment(overrides: Partial<EventAttachmentV1> = {}): EventAttachmentV1 {
  return {
    attachmentId: "att-1",
    kind: "image",
    mimeType: "image/jpeg",
    url: "https://storage.example/x?sig=Y",
    expiresAt: "2026-08-25T15:15:00Z",
    ...overrides,
  };
}

describe("authorLine — a role, an organization, never a person", () => {
  it("names the organization when the record has one", () => {
    expect(
      authorLine({ roleLabel: "Veterinario/a", verified: true, orgDisplayName: "Vet Palermo" }),
    ).toBe("Veterinario/a · Vet Palermo · firma verificada");
  });

  it("marks verification only when it happened", () => {
    // Naming a vet is a CLAIM; only their signature is verification, and the two
    // must read as unmistakably different.
    expect(authorLine({ roleLabel: "Dueño/a", verified: false, orgDisplayName: null })).toBe(
      "Dueño/a",
    );
  });
});

describe("amendmentChangeLine — replaced, added and cleared are three facts", () => {
  it("reads a replacement as a replacement", () => {
    expect(amendmentChangeLine({ label: "Vacuna", from: "Antirabica", to: "Antirrábica" })).toBe(
      "Vacuna: «Antirabica» → «Antirrábica»",
    );
  });

  it("reads a field that had no value as ADDED, not as replaced by nothing", () => {
    expect(amendmentChangeLine({ label: "Lote", from: null, to: "L-42" })).toBe(
      "Lote: se agregó «L-42»",
    );
  });

  it("reads a cleared field as CLEARED, not as «L-42» → «»", () => {
    // "Lote: «L-42» → «»" reads as a typo. This reads as what happened.
    expect(amendmentChangeLine({ label: "Lote", from: "L-42", to: null })).toBe(
      "Lote: se borró «L-42»",
    );
  });

  it("dates a step in the Argentine calendar and names who made it", () => {
    expect(
      amendmentHeadline({
        amendmentId: "a1",
        occurredAt: "2026-08-23T01:00:00Z",
        reason: null,
        actorRoleLabel: "Dueño/a",
        changes: [],
      }),
    ).toBe("22/08/2026 · Dueño/a");
  });
});

describe("attachment expiry — the link genuinely stops working, so the screen says when", () => {
  it("prints the clock time the link dies", () => {
    // 15:15 UTC is 12:15 in Buenos Aires — pinned, like every other date here.
    expect(attachmentExpiryLabel("2026-08-25T15:15:00Z", NOW)).toBe("El enlace vence a las 12:15");
  });

  it("says the link is gone and points at the fix once it is past", () => {
    expect(attachmentExpiryLabel("2026-08-25T14:59:00Z", NOW)).toBe(
      "El enlace venció. Actualizá para volver a verlo.",
    );
  });

  it("treats an absent expiry as an absent link, not as a link without a deadline", () => {
    expect(attachmentExpiryLabel(null, NOW)).toBe(ATTACHMENT_UNAVAILABLE_LABEL);
  });

  it("counts a link expired at the exact instant it expires", () => {
    // The boundary belongs to the dead side: offering a URL at the moment the
    // signature stops being valid is a guaranteed broken image.
    expect(attachmentExpired(attachment({ expiresAt: NOW.toISOString() }), NOW)).toBe(true);
    expect(attachmentExpired(attachment(), NOW)).toBe(false);
  });

  it("treats a file the server could not sign as expired, so nothing is offered", () => {
    expect(attachmentExpired(attachment({ url: null, expiresAt: null }), NOW)).toBe(true);
  });
});

describe("buildAmendChanges — a correction names what CHANGED", () => {
  const VACUNA = "vaccination_administered";
  const facts = [
    fact("vaccine_name", "Vacuna", "Antirrábica"),
    fact("brand", "Marca", "Nobivac"),
    fact("batch", "Lote", "L-42"),
  ];

  it("starts from the record's own values", () => {
    expect(initialAmendEdits(VACUNA, facts)).toEqual({
      vaccine_name: "Antirrábica",
      brand: "Nobivac",
      batch: "L-42",
    });
  });

  it("sends nothing when nothing moved", () => {
    expect(buildAmendChanges(VACUNA, facts, initialAmendEdits(VACUNA, facts))).toEqual([]);
  });

  it("sends ONLY the fields that moved", () => {
    // Submitting every field would write "Lote: «L-42» → «L-42»" into a history
    // somebody reads and make the real change impossible to find.
    const edits = { ...initialAmendEdits(VACUNA, facts), batch: "L-99" };
    expect(buildAmendChanges(VACUNA, facts, edits)).toEqual([{ field: "batch", value: "L-99" }]);
  });

  it("ignores whitespace a keyboard added", () => {
    const edits = { ...initialAmendEdits(VACUNA, facts), brand: "  Nobivac  " };
    expect(buildAmendChanges(VACUNA, facts, edits)).toEqual([]);
  });

  it("sends NULL for an emptied field, never an empty string", () => {
    // `null` clears the field; "" would store a blank value that later reads as
    // something somebody typed.
    const edits = { ...initialAmendEdits(VACUNA, facts), batch: "   " };
    expect(buildAmendChanges(VACUNA, facts, edits)).toEqual([{ field: "batch", value: null }]);
  });

  it("can only name fields the curated projection already renders", () => {
    // The form is built from `facts`, so a key the whitelist never emitted —
    // a hash, an internal id — has no input and cannot become a change.
    const edits = { ...initialAmendEdits(VACUNA, facts), firma_hash: "tampered" };
    expect(buildAmendChanges(VACUNA, facts, edits).map((c) => c.field)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-02 — A FORMATTED VALUE MAY NEVER BE POSTED AS A RAW ONE
// ---------------------------------------------------------------------------
//
// The wire carries `{field, label, value}` and `value` is the DISPLAY string, so
// the form was pre-filling "12/03/2026" for `next_due_at` and posting the edited
// TEXT into a field the projection reads as an instant. The row then vanishes and
// the correction history says "se borró"; edited to "12/04/2026" it is parsed
// US-style as 4 December, and NOTHING in the data marks that as wrong. The spine
// is append-only, so both are permanent.
//
// EVERY ASSERTION BELOW IS ON THE LAYER THAT PERSISTS. `buildAmendChanges` is
// what the submit hands to the writer; a test that only proved the screen drew
// fewer boxes could not see a state map that still carried the formatted date.

describe("A2-alta-asentar-02 — only a row whose text IS the wire value may be corrected", () => {
  it("refuses a FORMATTED DATE even when the edits map carries one", () => {
    // The exact defect: `next_due_at` holds an instant and renders dd/mm/yyyy.
    const facts = [
      fact("batch", "Lote", "L-42"),
      fact("next_due_at", "Próxima dosis", "12/03/2026"),
    ];
    const changes = buildAmendChanges("vaccination_administered", facts, {
      batch: "L-42",
      next_due_at: "15/03/2026",
    });

    expect(changes).toEqual([]);
  });

  it("refuses an ENUM rendered as its es-AR label", () => {
    // `type` is one of internal|external|both; the ledger shows "interno".
    // Posting "externo" would write the LABEL into the enum key.
    const facts = [fact("product", "Producto", "Endogard"), fact("type", "Tipo", "interno")];
    const changes = buildAmendChanges("deworming_administered", facts, {
      product: "Endogard",
      type: "externo",
    });

    expect(changes).toEqual([]);
  });

  it("refuses a weight, whose row is the FORMATTED number and nothing else", () => {
    // `kg` is a parseable string in the spine and renders as "12,5 kg". A peso
    // therefore has no editable row at all — which is why the screen does not
    // offer the form for one.
    const facts = [fact("kg", "Peso", "12,5 kg")];

    expect(amendableFacts("weight_recorded", facts)).toEqual([]);
    expect(buildAmendChanges("weight_recorded", facts, { kg: "13 kg" })).toEqual([]);
  });

  it("still corrects the free-text rows beside them", () => {
    // The mitigation removes a capability; it must not remove the whole feature.
    const facts = [
      fact("batch", "Lote", "L-42"),
      fact("next_due_at", "Próxima dosis", "12/03/2026"),
    ];
    const changes = buildAmendChanges("vaccination_administered", facts, {
      batch: "L-99",
      next_due_at: "15/03/2026",
    });

    expect(changes).toEqual([{ field: "batch", value: "L-99" }]);
  });

  it("never seeds the form's state with a value it will not accept back", () => {
    // Belt: an entry in `edits` is an input on screen. A formatted date sitting
    // in that map is a box somebody can type into and a value the submit would
    // have to filter twice.
    const facts = [
      fact("batch", "Lote", "L-42"),
      fact("next_due_at", "Próxima dosis", "12/03/2026"),
    ];

    expect(initialAmendEdits("vaccination_administered", facts)).toEqual({ batch: "L-42" });
  });

  it("is an ALLOWLIST: an unknown event type and an unknown key are read-only", () => {
    // The direction is the point. A fact key or an event type that appears next
    // month is refused by DEFAULT rather than admitted until somebody notices it
    // is formatted — the opposite of banning the shapes known to be dangerous
    // today.
    expect(isPassThroughFact("vaccination_administered", "batch")).toBe(true);
    expect(isPassThroughFact("una_cosa_nueva", "batch")).toBe(false);
    expect(isPassThroughFact("vaccination_administered", "un_campo_nuevo")).toBe(false);
  });

  it("names the destination for the rows it will not edit, and names it as the web", () => {
    // A capability removed with no destination leaves somebody hunting. The web's
    // own form seeds from the RAW payload, so it is a real place to go.
    const facts = [
      fact("batch", "Lote", "L-42"),
      fact("next_due_at", "Próxima dosis", "12/03/2026"),
    ];

    expect(readOnlyFacts("vaccination_administered", facts).map((f) => f.field)).toEqual([
      "next_due_at",
    ]);
    expect(AMEND_READ_ONLY_NOTE).toContain("miMAR en la web");
    expect(AMEND_NO_EDITABLE_FACTS_NOTE).toContain("miMAR en la web");
  });

  it("refuses an ISO COUNTRY CODE even though the projection renders it verbatim", () => {
    // VERBATIM IS NECESSARY AND NOT SUFFICIENT — the rule's first draft stopped
    // at verbatim and admitted these two. `to_country` is hardcoded `AR` by the
    // writer and `origin_country` is `z.string().length(2)`; the phone drew a box
    // labelled "País de destino" containing `AR`. An owner "correcting" it to
    // `Argentina` lands (nothing re-validates an amended payload), and the cache
    // refresher then gates canonicalisation on `toCountry === "AR"` — so
    // `pets.localityId` goes null and province and locality stop being canonical.
    const facts = [
      fact("to_country", "País de destino", "AR"),
      fact("reason", "Motivo", "mudanza"),
    ];

    expect(isPassThroughFact("movement_recorded", "to_country")).toBe(false);
    expect(isPassThroughFact("movement_recorded", "origin_country")).toBe(false);
    expect(amendableFacts("movement_recorded", facts).map((f) => f.field)).toEqual(["reason"]);
    expect(
      buildAmendChanges("movement_recorded", facts, {
        to_country: "Argentina",
        reason: "mudanza",
      }),
    ).toEqual([]);
  });

  it("refuses the two halves of a jurisdiction IDENTITY, and keeps the reason editable", () => {
    // Correcting where an animal lives is a MOVE, not a text edit: the
    // destination is identified by `to_locality_id`, and a box that edits only
    // the NAME leaves the id on the original row. Worse, the server's own cache
    // refresher re-resolves the destination on ANY amendment to the event, so
    // correcting the free-text `reason` must not be able to carry a new name
    // with it.
    const facts = [
      fact("to_province", "Provincia de destino", "Santiago del Estero"),
      fact("to_locality", "Localidad de destino", "San Pedro"),
      fact("reason", "Motivo", "mudanza"),
    ];

    expect(readOnlyFacts("movement_recorded", facts).map((f) => f.field)).toEqual([
      "to_province",
      "to_locality",
    ]);
    expect(
      buildAmendChanges("movement_recorded", facts, {
        to_province: "Buenos Aires",
        to_locality: "La Plata",
        reason: "traslado laboral",
      }),
    ).toEqual([{ field: "reason", value: "traslado laboral" }]);
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-02 (F6) — THE ALLOWLIST GOVERNS ROWS, NOT VALUES
// ---------------------------------------------------------------------------

describe("an emptied box may not write null into a field the spine requires", () => {
  it("drops the change instead of posting `value: null` on a required key", () => {
    // `vaccine_name` is `z.string()` in the spine, not `z.string().nullable()`,
    // and nothing re-validates an amended payload — so this used to land, and
    // the projection then dropped the row entirely.
    const facts = [fact("vaccine_name", "Vacuna", "Antirrábica"), fact("batch", "Lote", "L-42")];

    expect(
      buildAmendChanges("vaccination_administered", facts, { vaccine_name: "", batch: "L-99" }),
    ).toEqual([{ field: "batch", value: "L-99" }]);
  });

  it("still CLEARS a key the spine declares nullable", () => {
    // The mitigation removes a dangerous write, not the capability: `batch` is
    // `z.string().nullable()`, and "se borró «L-42»" is a fact somebody may need
    // to record.
    const facts = [fact("batch", "Lote", "L-42")];

    expect(buildAmendChanges("vaccination_administered", facts, { batch: "  " })).toEqual([
      { field: "batch", value: null },
    ]);
  });

  it("names the emptied field so the refusal is not silence", () => {
    const facts = [fact("text", "Nota", "hola"), fact("vaccine_name", "Vacuna", "Antirrábica")];

    expect(clearedRequiredFact("note_added", facts, { text: "hola" })).toBeNull();
    expect(clearedRequiredFact("note_added", facts, { text: "   " })?.label).toBe("Nota");
    // Only rows this app actually put in a box are consulted: `vaccine_name` is
    // required on a vaccination and is not a `note_added` row at all.
    expect(clearedRequiredFact("note_added", facts, { text: "hola", vaccine_name: "" })).toBeNull();
    expect(amendRequiredFactMessage("Nota")).toContain("«Nota»");
  });

  it("is a two-way list: cvi_number is required, purpose is not", () => {
    expect(isRequiredFact("movement_recorded", "cvi_number")).toBe(true);
    expect(isRequiredFact("movement_recorded", "issuing_authority")).toBe(true);
    expect(isRequiredFact("movement_recorded", "purpose")).toBe(false);
    expect(isRequiredFact("sterilization_performed", "clinic")).toBe(false);
    expect(isRequiredFact("una_cosa_nueva", "text")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-02 (F4) — THE HANDOFF SENTENCE MUST BE TRUE
// ---------------------------------------------------------------------------

describe("the no-editable-rows copy states a reason that holds", () => {
  it("does not claim formatted rows on an asiento that renders none", () => {
    // `medication_started` and `clinical_info_logged` are amendable and have no
    // arm in `eventPayloadDetails`. Telling that person "los que tiene se
    // muestran con formato" right after the screen said "Sin campos adicionales"
    // is a false statement on a citizen surface.
    expect(amendNoEditableFactsNote([])).toBe(AMEND_NO_CURATED_FACTS_NOTE);
    expect(AMEND_NO_CURATED_FACTS_NOTE).not.toContain("se muestran con formato");
    // The destination clause survives: the web's form lists every raw key, so
    // `drug_name` and `dose` genuinely are correctable there.
    expect(AMEND_NO_CURATED_FACTS_NOTE).toContain("miMAR en la web");
  });

  it("keeps the formatted-rows reason where it is true", () => {
    expect(amendNoEditableFactsNote([fact("kg", "Peso", "12,5 kg")])).toBe(
      AMEND_NO_EDITABLE_FACTS_NOTE,
    );
  });
});

// ---------------------------------------------------------------------------
// A2-alta-asentar-07 — THE CORRECTION IS VALIDATED BEFORE IT IS SENT
// ---------------------------------------------------------------------------

describe("buildAmendEventCommand", () => {
  const CHANGE = { field: "lote", value: "AB-12" };

  it("names the reason's length instead of letting the wire say 'Actualizá la app'", () => {
    // The error envelope is one key, so a 400 from this write arrives as
    // `invalid_request` — whose copy tells somebody with a four-character
    // motivo to update an app that understood them perfectly.
    const built = buildAmendEventCommand({ reason: "typo", changes: [CHANGE] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("REASON_TOO_SHORT");
    expect(built.message).toContain("5 caracteres");
    expect(built.message).not.toContain("Actualizá");
  });

  it("treats an empty motivo as ABSENT, not as a five-character failure", () => {
    // A correction by an owner may omit the reason entirely — the CHANGE is the
    // record. Sending "" would be refused for a field they deliberately left
    // alone.
    const built = buildAmendEventCommand({ reason: "   ", changes: [CHANGE] });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.input.reason).toBeNull();
    expect(built.input.changes).toEqual([CHANGE]);
  });

  it("still refuses a correction that changes nothing", () => {
    const built = buildAmendEventCommand({ reason: "", changes: [] });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.code).toBe("CHANGES_REQUIRED");
  });
});
