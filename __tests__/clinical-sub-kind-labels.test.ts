// Fence — every clinical sub_kind must have a Spanish label.
//
// `describeEvent` maps sub_kind → label with a `?? subKind` fallback, so a
// missing entry does not throw or blank out: it prints the raw English
// identifier into a Spanish medical record and looks deliberate. That is
// exactly how "Información clínica · pregnancy" reached a pet's timeline on
// staging (clickthrough 2026-08-13) — the schema had seven sub_kinds and the
// label map had five, and nothing anywhere compared the two lists.
//
// This test compares them.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** sub_kind values accepted by `clinicalInfoLogged` in the event schema. */
function schemaSubKinds(): string[] {
  const source = readFileSync("lib/events/event-schemas.ts", "utf8");
  // The enum immediately preceding the clinical-info `title` field.
  const block = source.match(/sub_kind: z\.enum\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("no se encontró el enum de sub_kind en event-schemas.ts");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

/** Keys of the `subKindLabels` map inside describeEvent. */
function labelledSubKinds(): string[] {
  const source = readFileSync("lib/events/events.ts", "utf8");
  const block = source.match(/const subKindLabels: Record<string, string> = \{([\s\S]*?)\};/);
  if (!block) throw new Error("no se encontró subKindLabels en events.ts");
  return [...block[1].matchAll(/([a-z_]+):\s*"/g)].map((m) => m[1]);
}

describe("clinical sub_kind labels", () => {
  it("reads both lists — a fence that parses nothing proves nothing", () => {
    expect(schemaSubKinds().length).toBeGreaterThan(3);
    expect(labelledSubKinds().length).toBeGreaterThan(3);
  });

  it("labels every sub_kind the schema accepts", () => {
    const labelled = new Set(labelledSubKinds());
    const missing = schemaSubKinds().filter((k) => !labelled.has(k));
    expect(
      missing,
      "Sin etiqueta, describeEvent imprime el identificador en inglés dentro de " +
        "una libreta sanitaria en castellano y nadie se entera.",
    ).toEqual([]);
  });

  it("has no label for a sub_kind the schema rejects", () => {
    // A stale entry is harmless at runtime but means the map is drifting; the
    // drift is what produced the original bug.
    const accepted = new Set(schemaSubKinds());
    expect(labelledSubKinds().filter((k) => !accepted.has(k))).toEqual([]);
  });
});
