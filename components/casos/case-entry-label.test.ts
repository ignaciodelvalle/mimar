// caseEntryLabel — the title a case-timeline entry renders under.
//
// WHY THIS EXISTS (rehome-by-titular, WU5 carry-forward 5 / spec REQ-5). The
// timeline merges pet_events and case_events and titled every row with
// `eventTypeLabel(e.eventType)`, a map keyed by pet EventType. A case_events
// entry (`case_closed`, `case_opened`, `reporter_comment`…) is not a pet
// event, so its title was `undefined` and the row rendered with no title at
// all — and the one payload key that tells an org decline apart from a
// titular cancel (`rehome_decision`) had a writer and no reader.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CASE_EVENT_ENTRY_TYPES } from "@/db/schema";

import { caseEntryLabel } from "./case-entry-label";

describe("caseEntryLabel — rehome_request closes read as WHO decided, not as a bare 'cerrado'", () => {
  it("an org decline names the organisation as the actor", () => {
    expect(
      caseEntryLabel("case_closed", { rehome_decision: "declined", organization_id: "o" }),
    ).toBe("Solicitud rechazada por la organización");
  });

  it("an org accept reads as accepted, not as a generic close", () => {
    expect(caseEntryLabel("case_closed", { rehome_decision: "accepted" })).toBe(
      "Solicitud aceptada por la organización",
    );
  });

  it("a titular's cancel or withdraw names the titular — distinguishable from a decline", () => {
    const label = caseEntryLabel("case_closed", { rehome_decision: "withdrawn" });
    expect(label).toBe("Cancelado por el titular");
    expect(label).not.toMatch(/rechaz/);
    expect(label).not.toMatch(/organización/);
  });

  it("an unknown decision value degrades to the plain close, never to the raw key", () => {
    const label = caseEntryLabel("case_closed", { rehome_decision: "something_else" });
    expect(label).toBe("Expediente cerrado");
    expect(label).not.toMatch(/something_else/);
  });
});

describe("caseEntryLabel — every case_events entry type has a title", () => {
  it("labels the operator/system entries in es-AR", () => {
    expect(caseEntryLabel("case_opened", null)).toBe("Expediente abierto");
    expect(caseEntryLabel("case_escalated", null)).toBe("Expediente escalado");
    expect(caseEntryLabel("case_closed", null)).toBe("Expediente cerrado");
    expect(caseEntryLabel("case_closed", {})).toBe("Expediente cerrado");
    expect(caseEntryLabel("reporter_comment", null)).toBe("Comentario de quien denunció");
    expect(caseEntryLabel("finder_tip", null)).toBe("Información de un tercero");
  });

  it("a pet event keeps the label the libreta already uses", () => {
    expect(caseEntryLabel("vaccination_administered", { vaccine: "x" })).toBe(
      caseEntryLabel("vaccination_administered", null),
    );
    expect(caseEntryLabel("vaccination_administered", null)).toMatch(/vacuna/i);
  });

  it("never renders an identifier for a type nobody labelled", () => {
    const label = caseEntryLabel("some_future_entry", null);
    expect(label).not.toMatch(/[a-z]+_[a-z]+/);
    expect(label.length).toBeGreaterThan(3);
  });
});

// WU5 review (LOW): the title map was `Record<string, string>`, so a fourteenth
// `case_events` entry type would have compiled clean and rendered the fallback
// — exactly the "untitled card" this reader exists to end. The map is now
// exhaustive BY TYPE against CASE_EVENT_ENTRY_TYPES: a new entry type without
// a title is a `tsc` error, not a runtime fallback.
describe("caseEntryLabel — the case_events title map is exhaustive by type", () => {
  it("declares `satisfies Record<CaseEventEntryType, string>` against the schema catalog", () => {
    const src = readFileSync(join(__dirname, "case-entry-label.ts"), "utf8");
    expect(src).toMatch(/satisfies Record<CaseEventEntryType, string>/);
    expect(src).toMatch(/import type \{[^}]*CaseEventEntryType[^}]*\} from "@\/db\/schema"/);
  });

  it("every entry type in CASE_EVENT_ENTRY_TYPES has a title that is neither the fallback nor an identifier", () => {
    for (const entryType of CASE_EVENT_ENTRY_TYPES) {
      const label = caseEntryLabel(entryType, null);
      expect(label, entryType).not.toBe("Registro en el expediente");
      expect(label, entryType).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });
});
