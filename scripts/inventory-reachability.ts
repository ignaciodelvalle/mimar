/**
 * Inventory & reachability audit — the INVERTED review.
 *
 * A screen-by-screen pass finds what is REDUNDANT. It structurally cannot find
 * what EXISTS AND NOBODY CAN REACH, because an unreachable asset renders on no
 * screen and therefore appears in no screenshot. This script starts from the
 * registries instead, so the orphan class is found by construction.
 *
 * PO framing 2026-07-25: "empecemos con todas las cosas que tenemos y son
 * valiosas y listamos donde aparecen, si es suficiente o redundante. Luego
 * validamos que ninguna de nuestras metricas, dashs, capas, vistas quede
 * inaccesible."
 *
 * Read-only: imports the pure domain registries and greps the source tree. It
 * touches no database, starts no server, and writes nothing but its report.
 *
 *   pnpm exec tsx scripts/inventory-reachability.ts
 *   pnpm exec tsx scripts/inventory-reachability.ts --json
 */

import { execFileSync } from "node:child_process";

import { PANORAMA_LAYERS, REFERENCE_LAYERS } from "../src/modules/panorama/domain/layers";
import { PANORAMA_PRESETS, presetLayerIds } from "../src/modules/panorama/domain/presets";

const asJson = process.argv.includes("--json");

// ---------------------------------------------------------------------------
// Source-tree reachability. `git grep -l` keeps us inside tracked files (no
// node_modules, no build output) and never mutates anything.
// ---------------------------------------------------------------------------

function filesMentioning(token: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", "--fixed-strings", token, "--", "app", "components", "src", "lib"],
      { encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    // git grep exits 1 when there are no matches — that is a real answer.
    return [];
  }
}

/** Mentions that are not tests, snapshots, or the registry that DEFINES the id.
 *  A layer named only by its own definition and its unit test is not reachable
 *  by any operator, however well tested it is. */
function productionSites(token: string, definingFile: string): string[] {
  return filesMentioning(token).filter(
    (f) =>
      !f.includes("__tests__") &&
      !f.includes(".test.") &&
      !f.includes("__snapshots__") &&
      !f.endsWith(definingFile),
  );
}

// ---------------------------------------------------------------------------
// 1 · Layers: which preset activates each one?
// ---------------------------------------------------------------------------

const layerToPresets = new Map<string, string[]>();
for (const layer of PANORAMA_LAYERS) layerToPresets.set(layer.id, []);
for (const preset of PANORAMA_PRESETS) {
  for (const layerId of presetLayerIds(preset)) {
    const bucket = layerToPresets.get(layerId);
    if (bucket) bucket.push(preset.id);
  }
}

const referenceIds = new Set(REFERENCE_LAYERS.map((l) => l.id));

const layerRows = PANORAMA_LAYERS.map((layer) => {
  const presets = layerToPresets.get(layer.id) ?? [];
  const sites = productionSites(layer.id, "layers.ts");
  return {
    id: layer.id,
    label: layer.label,
    valueKind: layer.valueKind ?? "count",
    isReference: referenceIds.has(layer.id),
    presets,
    presetCount: presets.length,
    productionSites: sites.length,
    // ORPHAN: built, typed, tested — and no vista turns it on. An operator can
    // never see it, so every hour spent building it is currently unrealised.
    orphan: presets.length === 0,
  };
});

// ---------------------------------------------------------------------------
// 2 · Presets (the 11 vistas): each one's label vs its layers' labels.
//     A preset whose label EQUALS one of its layer labels makes the on-screen
//     caption repeat itself ("Síntomas — …. Capas: …, Síntomas.").
// ---------------------------------------------------------------------------

const presetRows = PANORAMA_PRESETS.map((preset) => {
  const layerIds = presetLayerIds(preset);
  const layerLabels = layerIds.map((id) => PANORAMA_LAYERS.find((l) => l.id === id)?.label ?? id);
  const echoes = layerLabels.filter((l) => l === preset.label);
  return {
    id: preset.id,
    label: preset.label,
    layers: layerIds,
    layerLabels,
    // The caption echo: the vista name is already rendered as "Vista · X"
    // directly above the caption, so a layer sharing that name states the same
    // words a third time in ~4 lines of screen.
    echoesOwnLabel: echoes.length > 0,
  };
});

// ---------------------------------------------------------------------------
// 3 · Report
// ---------------------------------------------------------------------------

const orphanLayers = layerRows.filter((r) => r.orphan);
const echoPresets = presetRows.filter((r) => r.echoesOwnLabel);

if (asJson) {
  console.log(JSON.stringify({ layers: layerRows, presets: presetRows }, null, 2));
} else {
  console.log("=== CAPAS ===");
  console.log("id | vistas que la activan | archivos de producción | tipo");
  for (const r of layerRows) {
    const flag = r.orphan ? "  <-- HUÉRFANA" : "";
    console.log(
      `${r.id} | ${r.presets.length === 0 ? "(ninguna)" : r.presets.join(", ")} | ${r.productionSites} | ${r.valueKind}${r.isReference ? " (referencia)" : ""}${flag}`,
    );
  }

  console.log("\n=== VISTAS ===");
  for (const r of presetRows) {
    console.log(
      `${r.id} | "${r.label}" | capas: ${r.layerLabels.join(" + ")}${r.echoesOwnLabel ? "  <-- el caption repite el nombre de la vista" : ""}`,
    );
  }

  console.log("\n=== RESUMEN ===");
  console.log(`capas totales: ${layerRows.length}`);
  console.log(`capas huérfanas (ninguna vista las activa): ${orphanLayers.length}`);
  if (orphanLayers.length > 0) {
    console.log(`  ${orphanLayers.map((r) => `${r.id} ("${r.label}")`).join("\n  ")}`);
  }
  console.log(`vistas totales: ${presetRows.length}`);
  console.log(`vistas cuyo caption repite su propio nombre: ${echoPresets.length}`);
  if (echoPresets.length > 0) {
    console.log(`  ${echoPresets.map((r) => r.id).join(", ")}`);
  }
}
