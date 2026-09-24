// Unit tests for the Panorama F2 layer-compatibility model (pure domain).

import { describe, expect, it } from "vitest";

import { checkCompatibility, roleOf } from "@/src/modules/panorama/domain/compatibility";
import type { LayerRole } from "@/src/modules/panorama/domain/compatibility";
import { PANORAMA_LAYERS } from "@/src/modules/panorama/domain/layers";

// ---------------------------------------------------------------------------
// roleOf — maps all 8 layers to the correct role
// ---------------------------------------------------------------------------

describe("roleOf", () => {
  it("maps cobertura (rate) → base", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "cobertura")!;
    expect(roleOf(layer)).toBe<LayerRole>("base");
  });

  it("maps mortalidad (density choropleth) → base", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "mortalidad")!;
    expect(roleOf(layer)).toBe<LayerRole>("base");
  });

  it("maps perdidas (density) → base", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "perdidas")!;
    expect(roleOf(layer)).toBe<LayerRole>("base");
  });

  it("maps mordeduras (density) → base", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "mordeduras")!;
    expect(roleOf(layer)).toBe<LayerRole>("base");
  });

  it("maps denuncias (density) → base", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "denuncias")!;
    expect(roleOf(layer)).toBe<LayerRole>("base");
  });

  it("maps zoonosis (signal) → signal", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "zoonosis")!;
    expect(roleOf(layer)).toBe<LayerRole>("signal");
  });

  it("maps refugios (reference) → reference", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "refugios")!;
    expect(roleOf(layer)).toBe<LayerRole>("reference");
  });

  it("maps decomisos (reference) → reference", () => {
    const layer = PANORAMA_LAYERS.find((l) => l.id === "decomisos")!;
    expect(roleOf(layer)).toBe<LayerRole>("reference");
  });

  it("covers all 9 layers (no unclassified layers)", () => {
    const validRoles = new Set<LayerRole>(["base", "signal", "reference"]);
    for (const layer of PANORAMA_LAYERS) {
      expect(validRoles.has(roleOf(layer))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility — empty active set
// ---------------------------------------------------------------------------

describe("checkCompatibility — empty active set", () => {
  it("allows any single base layer when nothing is active", () => {
    for (const id of [
      "cobertura",
      "esterilizacion",
      "mortalidad",
      "perdidas",
      "mordeduras",
      "denuncias",
    ] as const) {
      expect(checkCompatibility([], id, PANORAMA_LAYERS)).toEqual({ allowed: true });
    }
  });

  it("allows the signal layer when nothing is active", () => {
    expect(checkCompatibility([], "zoonosis", PANORAMA_LAYERS)).toEqual({ allowed: true });
  });

  it("allows reference layers when nothing is active", () => {
    expect(checkCompatibility([], "refugios", PANORAMA_LAYERS)).toEqual({ allowed: true });
    expect(checkCompatibility([], "decomisos", PANORAMA_LAYERS)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility — base-slot constraint (at most 1 base)
// ---------------------------------------------------------------------------

describe("checkCompatibility — base-slot constraint", () => {
  it("blocks activating mortalidad when cobertura is already active", () => {
    const result = checkCompatibility(["cobertura"], "mortalidad", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
    expect(result.hint).toMatch(/Cobertura antirrábica/); // conflicting layer label
  });

  it("blocks activating denuncias when perdidas is already active", () => {
    const result = checkCompatibility(["perdidas"], "denuncias", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
    expect(result.hint).toMatch(/Pérdidas \/ avistajes/);
  });

  it("blocks activating a second density layer (perdidas active, propose mordeduras)", () => {
    const result = checkCompatibility(["perdidas"], "mordeduras", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
  });

  it("blocks activating a second density layer (denuncias active, propose mortalidad)", () => {
    const result = checkCompatibility(["denuncias"], "mortalidad", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
  });

  it("blocks when base + signal are active and another base is proposed", () => {
    const result = checkCompatibility(["perdidas", "zoonosis"], "denuncias", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
  });

  it("blocks when base + references are active and another base is proposed", () => {
    const result = checkCompatibility(
      ["cobertura", "refugios", "decomisos"],
      "perdidas",
      PANORAMA_LAYERS,
    );
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/capa base activa/);
  });

  it("includes the conflicting layer label in the hint (human-readable)", () => {
    const result = checkCompatibility(["mordeduras"], "denuncias", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    // The hint must mention the already-active layer's label (Mordeduras / antirrábica)
    expect(result.hint).toContain("Mordeduras / antirrábica");
  });

  it("includes guidance about signals and references in the base-conflict hint", () => {
    const result = checkCompatibility(["perdidas"], "cobertura", PANORAMA_LAYERS);
    expect(result.hint).toMatch(/señales y referencias van encima/);
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility — signal-slot constraint (at most 1 signal)
// ---------------------------------------------------------------------------

describe("checkCompatibility — signal-slot constraint", () => {
  it("blocks a second signal when zoonosis is already active (hypothetical registry extension)", () => {
    // Extend the registry with a hypothetical second signal layer for the test.
    const extraSignal = {
      ...PANORAMA_LAYERS.find((l) => l.id === "zoonosis")!,
      id: "zoonosis2" as const,
      label: "Señal extra",
      source: "outbreak_signals:extra",
    };
    const registry = [...PANORAMA_LAYERS, extraSignal] as (typeof PANORAMA_LAYERS)[number][];

    const result = checkCompatibility(["zoonosis"], "zoonosis2" as never, registry as never);
    expect(result.allowed).toBe(false);
    expect(result.hint).toMatch(/señal activa/);
    expect(result.hint).toMatch(/Zoonosis \/ señales/); // conflicting layer label
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility — allowed combinations
// ---------------------------------------------------------------------------

describe("checkCompatibility — allowed combinations", () => {
  it("allows base + signal (base active, propose signal)", () => {
    expect(checkCompatibility(["perdidas"], "zoonosis", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("allows signal + base (signal active, propose base)", () => {
    expect(checkCompatibility(["zoonosis"], "perdidas", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("allows base + signal + references (base+signal active, propose reference)", () => {
    expect(checkCompatibility(["perdidas", "zoonosis"], "refugios", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
    expect(checkCompatibility(["perdidas", "zoonosis"], "decomisos", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("allows stacking both references regardless of bases/signals (refugios + decomisos)", () => {
    expect(
      checkCompatibility(["perdidas", "zoonosis", "refugios"], "decomisos", PANORAMA_LAYERS),
    ).toEqual({ allowed: true });
  });

  it("allows reference on top of nothing", () => {
    expect(checkCompatibility([], "refugios", PANORAMA_LAYERS)).toEqual({ allowed: true });
    expect(checkCompatibility([], "decomisos", PANORAMA_LAYERS)).toEqual({ allowed: true });
  });

  it("allows reference when another reference is already the only active layer", () => {
    expect(checkCompatibility(["refugios"], "decomisos", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("allows reference when a base is active (no conflict for reference role)", () => {
    expect(checkCompatibility(["cobertura"], "refugios", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
    expect(checkCompatibility(["mortalidad"], "decomisos", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("allows signal when no signal is active (base already on)", () => {
    expect(checkCompatibility(["cobertura"], "zoonosis", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
  });

  it("full allowed combination: base + signal + refugios + decomisos, adding base is blocked but each sub-add is allowed", () => {
    // Simulate building up the full allowed combination step by step.
    expect(checkCompatibility([], "perdidas", PANORAMA_LAYERS)).toEqual({ allowed: true });
    expect(checkCompatibility(["perdidas"], "zoonosis", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
    expect(checkCompatibility(["perdidas", "zoonosis"], "refugios", PANORAMA_LAYERS)).toEqual({
      allowed: true,
    });
    expect(
      checkCompatibility(["perdidas", "zoonosis", "refugios"], "decomisos", PANORAMA_LAYERS),
    ).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// checkCompatibility — hint content
// ---------------------------------------------------------------------------

describe("checkCompatibility — hint strings", () => {
  it("base-conflict hint is in es-AR and mentions the conflicting layer label", () => {
    const result = checkCompatibility(["cobertura"], "perdidas", PANORAMA_LAYERS);
    expect(result.allowed).toBe(false);
    expect(typeof result.hint).toBe("string");
    // es-AR phrasing
    expect(result.hint).toMatch(/Elegí/);
    // conflicting label
    expect(result.hint).toContain("Cobertura antirrábica");
  });

  it("signal-conflict hint is in es-AR and mentions the conflicting layer label", () => {
    // Use a synthetic second signal.
    const extraSignal = {
      ...PANORAMA_LAYERS.find((l) => l.id === "zoonosis")!,
      id: "zoonosis2" as const,
      label: "Señal extra",
      source: "signals:extra",
    };
    const registry = [...PANORAMA_LAYERS, extraSignal];
    const result = checkCompatibility(["zoonosis"], "zoonosis2" as never, registry as never);
    expect(result.allowed).toBe(false);
    // es-AR phrasing
    expect(result.hint).toMatch(/Solo se permite/);
    // conflicting label
    expect(result.hint).toContain("Zoonosis / señales");
  });

  it("allowed results never carry a hint", () => {
    const allowed = checkCompatibility(["perdidas"], "zoonosis", PANORAMA_LAYERS);
    expect(allowed.allowed).toBe(true);
    expect(allowed.hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Declared bivariate pair exception (new-vistas wave)
// ---------------------------------------------------------------------------

describe("checkCompatibility — declared bivariate pair exception", () => {
  it("allows the riesgo-ppp pair to co-activate in either order (ppp × mordeduras)", () => {
    expect(checkCompatibility(["ppp"], "mordeduras", PANORAMA_LAYERS).allowed).toBe(true);
    expect(checkCompatibility(["mordeduras"], "ppp", PANORAMA_LAYERS).allowed).toBe(true);
  });

  it("still blocks a second base OUTSIDE a declared pair", () => {
    // Same shapes as the pair (rate + density) but not vetted — blocked.
    expect(checkCompatibility(["ppp"], "denuncias", PANORAMA_LAYERS).allowed).toBe(false);
    expect(checkCompatibility(["esterilizacion"], "mordeduras", PANORAMA_LAYERS).allowed).toBe(
      false,
    );
    // A third base over an active pair is still a base conflict.
    expect(checkCompatibility(["ppp", "mordeduras"], "cobertura", PANORAMA_LAYERS).allowed).toBe(
      false,
    );
  });
});
