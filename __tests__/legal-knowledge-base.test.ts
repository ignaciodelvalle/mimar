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
    expect(labels.some((l) => l.includes("284"))).toBe(true); // Res. SENASA 284/2024 — ISO 11784/11785
  });
});
