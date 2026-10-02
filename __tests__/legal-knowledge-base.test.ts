// Content-shape tests for the /leyes public legal knowledge base
// (lib/reference/legal-knowledge-base.ts). Mirrors the coverage style of
// __tests__/disease-legal-anchors.test.ts: every entry must be complete
// enough to render the ficha (¿Qué dice? / ¿A quién aplica? / ¿Qué
// obligación implica en MiMAR? / Fuente) with no empty fields, and ids must
// be unique for stable deep-linking.

import { describe, expect, it } from "vitest";

import {
  LEGAL_KNOWLEDGE_GROUPS,
  getAllLegalKnowledgeEntries,
} from "@/lib/reference/legal-knowledge-base";

describe("legal-knowledge-base — group structure", () => {
  it("has at least the four required life-moment groups", () => {
    const ids = LEGAL_KNOWLEDGE_GROUPS.map((g) => g.id);
    expect(ids).toContain("identificacion");
    expect(ids).toContain("bienestar");
    expect(ids).toContain("zoonosis");
    expect(ids).toContain("datos-personales");
  });

  it("every group has a non-empty title, intro and at least one entry", () => {
    for (const group of LEGAL_KNOWLEDGE_GROUPS) {
      expect(group.title.trim().length, `group ${group.id} missing title`).toBeGreaterThan(0);
      expect(group.intro.trim().length, `group ${group.id} missing intro`).toBeGreaterThan(0);
      expect(group.entries.length, `group ${group.id} has no entries`).toBeGreaterThan(0);
    }
  });

  it("group ids are unique", () => {
    const ids = LEGAL_KNOWLEDGE_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("legal-knowledge-base — entry completeness", () => {
  const entries = getAllLegalKnowledgeEntries();

  it("has entries", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("entry ids are unique across all groups (stable deep-links)", () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(entries.map((e) => [e.id, e] as const))(
    "%s has all ficha fields populated",
    (_id, entry) => {
      expect(entry.lawLabel.trim().length).toBeGreaterThan(0);
      expect(entry.plainMeaning.trim().length).toBeGreaterThan(0);
      expect(entry.whatItSays.trim().length).toBeGreaterThan(0);
      expect(entry.whoItAppliesTo.trim().length).toBeGreaterThan(0);
      expect(entry.mimarObligation.trim().length).toBeGreaterThan(0);
      expect(entry.sourceLabel.trim().length).toBeGreaterThan(0);
      expect(["Nacional", "CABA", "Buenos Aires", "Internacional"]).toContain(
        entry.jurisdictionBadge,
      );
    },
  );

  it("every populated sourceUrl is a well-formed https URL", () => {
    for (const entry of entries) {
      if (entry.sourceUrl === undefined) continue;
      expect(() => new URL(entry.sourceUrl as string)).not.toThrow();
      expect(entry.sourceUrl.startsWith("https://")).toBe(true);
    }
  });

  it("cites the laws the /leyes page is required to cover", () => {
    const labels = entries.map((e) => e.lawLabel);
    expect(labels.some((l) => l.includes("14.346"))).toBe(true); // maltrato
    expect(labels.some((l) => l.includes("25.326"))).toBe(true); // datos personales
    expect(labels.some((l) => l.includes("5470"))).toBe(true); // cremación CABA
    expect(labels.some((l) => l.includes("4.669") || l.includes("4669"))).toBe(true); // Decreto 4669/1973
    expect(labels.some((l) => l.includes("14.107"))).toBe(true); // PPP PBA, chip o tatuaje
    expect(labels.some((l) => l.includes("art. 141"))).toBe(true); // abandono, CABA
    expect(labels.some((l) => l.includes("654/2026"))).toBe(true); // receta electrónica
    expect(labels.some((l) => l.includes("2076/2025"))).toBe(true); // viajes en ómnibus y tren
  });
});

// The October 2026 legal review found citations that no official text
// supports, and copy that read like code or like a chat. These pin the
// corrections so a later edit cannot quietly bring them back.
describe("legal-knowledge-base — revision of 2026-10", () => {
  const entries = getAllLegalKnowledgeEntries();
  const fieldsOf = (e: (typeof entries)[number]) =>
    [e.lawLabel, e.plainMeaning, e.whatItSays, e.whoItAppliesTo, e.mimarObligation] as const;
  const allText = () =>
    [
      ...LEGAL_KNOWLEDGE_GROUPS.flatMap((g) => [g.title, g.intro]),
      ...entries.flatMap(fieldsOf),
    ].join("\n");

  it("does not present the equine Res. SENASA 284/2024 as the pet-chip standard", () => {
    expect(allText()).not.toContain("284");
  });

  it("does not cite the unfound Res. MS 546/1985", () => {
    expect(allText()).not.toContain("546");
  });

  it("does not call the CVPBA manual a resolution", () => {
    expect(allText()).not.toMatch(/Resoluci[oó]n CVPBA 05/);
    expect(allText()).toContain("Manual de enfermedades de notificación obligatoria del CVPBA");
  });

  it("drops the unverified nickname and the peso figure of Ley CABA 6.839", () => {
    expect(allText()).not.toContain("Huellas");
    expect(allText()).not.toMatch(/\$\s?8/);
    expect(allText()).toContain("60 a 90 días");
  });

  it("says Ley 14.346 does not punish abandonment as its own offence", () => {
    const entry = entries.find((e) => e.id === "ley-14346");
    expect(entry?.whatItSays).toContain("No castiga el abandono");
  });

  it("names the AAIP as the data-protection control body", () => {
    const entry = entries.find((e) => e.id === "ley-25326");
    expect(entry?.whoItAppliesTo).toContain("Agencia de Acceso a la Información Pública");
  });

  it.each(entries.map((e) => [e.id, e] as const))(
    "%s shows no code identifiers to the public",
    (_id, entry) => {
      for (const field of fieldsOf(entry)) {
        expect(field).not.toContain("`");
        expect(field).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
        expect(field).not.toMatch(/\blib\//);
        expect(field).not.toMatch(/\.tsx?\b/);
      }
    },
  );

  it.each(entries.map((e) => [e.id, e] as const))(
    "%s keeps every field at 45 words or fewer",
    (_id, entry) => {
      for (const field of [
        entry.plainMeaning,
        entry.whatItSays,
        entry.whoItAppliesTo,
        entry.mimarObligation,
      ]) {
        expect(field.trim().split(/\s+/).length, field).toBeLessThanOrEqual(45);
      }
    },
  );

  it("keeps the colloquial phrases out", () => {
    for (const phrase of [
      "sí o sí",
      "se enteran y ya",
      "cualquier lado",
      "probablemente",
      "hace poco",
    ]) {
      expect(allText()).not.toContain(phrase);
    }
  });
});
