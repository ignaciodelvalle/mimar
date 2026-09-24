/**
 * Unit tests for scripts/check-metric-labels.ts — the KPI label/definition
 * consistency guard (night-1 dataviz/honesty audit, item 2). Pure fixture
 * tests: exercise scanForLabelConflicts against small synthetic file contents
 * so the guard's own logic is pinned independently of the live app/ tree.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  INLINE_CATALOG_LABEL_BASELINE,
  METRIC_LABEL_ALLOWLIST,
  scanForInlineCatalogLabels,
  scanForLabelConflicts,
} from "@/scripts/check-metric-labels";

const tempDirs: string[] = [];

function writeFixture(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "check-metric-labels-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scanForLabelConflicts", () => {
  it("flags the same static label rendered with two different static definitions", () => {
    const fileA = writeFixture(
      "PageA.tsx",
      `
      <OpKpi
        label="Cobertura antirrábica"
        value="42%"
        info={{ definition: "Perros con dosis en los últimos 12 meses." }}
      />
      `,
    );
    const fileB = writeFixture(
      "PageB.tsx",
      `
      <OpKpi
        label="Cobertura antirrábica"
        value="54%"
        info={{ definition: "Cualquier especie, cualquier momento." }}
      />
      `,
    );

    const byLabel = scanForLabelConflicts([fileA, fileB]);
    const entries = byLabel.get("Cobertura antirrábica");
    expect(entries).toHaveLength(2);
    const uniqueDefs = new Set(entries?.map((e) => e.definition));
    expect(uniqueDefs.size).toBe(2);
  });

  it("does not flag the same label with the SAME static definition repeated", () => {
    const content = `
      <OpKpi
        label="Disputas de custodia"
        value={String(n)}
        info={{ definition: "Disputas de custodia abiertas en la jurisdicción seleccionada." }}
      />
    `;
    const fileA = writeFixture("PageA.tsx", content);
    const fileB = writeFixture("PageB.tsx", content);

    const byLabel = scanForLabelConflicts([fileA, fileB]);
    const entries = byLabel.get("Disputas de custodia");
    const uniqueDefs = new Set(entries?.map((e) => e.definition));
    expect(uniqueDefs.size).toBe(1);
  });

  it("skips a dynamic label from the comparison entirely (cannot be statically resolved)", () => {
    const fileA = writeFixture(
      "PageA.tsx",
      `<OpKpi label={SOME_LABEL_CONSTANT} info={{ definition: "A" }} />`,
    );
    const byLabel = scanForLabelConflicts([fileA]);
    // A dynamic label produces no entry at all — nothing to compare it against.
    expect(byLabel.size).toBe(0);
  });

  it("skips a dynamic (interpolated) definition, but still records the static label", () => {
    const fileA = writeFixture(
      "PageA.tsx",
      `<OpKpi label="Meta chip" info={{ definition: \`meta \${TARGETS.X}%\` }} />`,
    );
    const byLabel = scanForLabelConflicts([fileA]);
    const entries = byLabel.get("Meta chip");
    expect(entries).toHaveLength(1);
    expect(entries?.[0].definition).toBeNull();
  });

  it("captures a multi-line info={{ ... }} block without truncating at the first inner brace", () => {
    const fileA = writeFixture(
      "PageA.tsx",
      `
      <OpKpi
        label="Total registradas"
        value={total}
        info={{
          definition: "Total de mascotas activas o extraviadas.",
          formula: "COUNT(pets) WHERE status IN ('active','lost')",
        }}
      />
      `,
    );
    const byLabel = scanForLabelConflicts([fileA]);
    const entries = byLabel.get("Total registradas");
    expect(entries?.[0].definition).toBe("Total de mascotas activas o extraviadas.");
  });
});

describe("scanForInlineCatalogLabels (registry-import fence)", () => {
  const LABELS = ["Penetración de microchip", "Cobertura de esterilización (stock)"] as const;

  it("flags a .tsx that retypes a catalogued label as an inline string literal", () => {
    const file = writeFixture(
      "PageA.tsx",
      `<OpKpi label="Penetración de microchip" value={pct} />`,
    );
    const hits = scanForInlineCatalogLabels([file], LABELS);
    expect(hits).toHaveLength(1);
    expect(hits[0].label).toBe("Penetración de microchip");
    expect(hits[0].count).toBe(1);
  });

  it("counts repeated inline occurrences, across quote styles", () => {
    const file = writeFixture(
      "PageA.tsx",
      [
        `<OpKpi label="Penetración de microchip" value={a} />`,
        `const t = 'Penetración de microchip';`,
        "const u = `Penetración de microchip`;",
      ].join("\n"),
    );
    const hits = scanForInlineCatalogLabels([file], LABELS);
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(3);
  });

  it("does not flag a file that renders the label via an imported constant", () => {
    // NOTE: the fixture's import specifier must stay a PURE module —
    // __tests__/db-reachability.ts scans raw source text (string literals
    // included), so a fixture importing a db-reaching module would silently
    // reclassify THIS test into the serial "db" project.
    const file = writeFixture(
      "PageA.tsx",
      [
        `import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";`,
        "<OpKpi label={KPI_CATALOG.microchip_penetration.label} value={pct} />",
      ].join("\n"),
    );
    expect(scanForInlineCatalogLabels([file], LABELS)).toHaveLength(0);
  });

  it("does not flag a partial/superstring match — only the exact quoted label", () => {
    const file = writeFixture(
      "PageA.tsx",
      `<OpKpi label="Penetración de microchip (histórico)" value={pct} />`,
    );
    expect(scanForInlineCatalogLabels([file], LABELS)).toHaveLength(0);
  });
});

describe("INLINE_CATALOG_LABEL_BASELINE", () => {
  it("uses repo-relative posix paths with positive grandfathered counts", () => {
    for (const [file, count] of Object.entries(INLINE_CATALOG_LABEL_BASELINE)) {
      expect(file).not.toMatch(/\\/);
      expect(file).toMatch(/^(app|components)\//);
      expect(count).toBeGreaterThan(0);
    }
  });
});

describe("METRIC_LABEL_ALLOWLIST", () => {
  it("is a non-empty set of known admin/gob scope-wording pairs", () => {
    expect(METRIC_LABEL_ALLOWLIST.size).toBeGreaterThan(0);
    expect(METRIC_LABEL_ALLOWLIST.has("Total registradas")).toBe(true);
  });

  it("does NOT allowlist 'Cobertura antirrábica' bare (the historic bug's exact label)", () => {
    // The historic bug shared this literal label across two truths. The fix was
    // to give each computation a DISTINCT, disambiguated label (see
    // lib/metrics/kpi-catalog.ts) — this label should never need an allowlist
    // entry because it should never collide again by construction.
    expect(METRIC_LABEL_ALLOWLIST.has("Cobertura antirrábica")).toBe(false);
  });
});
