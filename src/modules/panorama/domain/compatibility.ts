// Panorama F2 — layer-compatibility model.
//
// Pure module: no DB, no React, no Next. Only imports from the domain layer.
// Called by PanoramaConsole before activating a layer (turning it ON).
// Turning a layer OFF is always allowed — never call this function for that case.
//
// Rule (spec F2):
//   - Base slot: at most 1 active layer with dataType "rate" or "density".
//   - Signal slot: at most 1 active layer with dataType "signal".
//   - Reference: dataType "reference" layers are unlimited; always allowed.

import { isDeclaredBivariatePair } from "./bivariate";
import type { PanoramaLayer } from "./types";
import type { LayerId } from "./types";

// Re-export so callers can use the type without importing from types.ts directly.
export type { LayerId };

/** Semantic role a layer plays in the compatibility model. */
export type LayerRole = "base" | "signal" | "reference";

/**
 * Map a layer's dataType to its compatibility role:
 *  - rate | density  → "base"   (at most 1 active at a time)
 *  - signal          → "signal" (at most 1 active at a time)
 *  - reference       → "reference" (unlimited)
 */
export function roleOf(layer: PanoramaLayer): LayerRole {
  if (layer.dataType === "rate" || layer.dataType === "density") return "base";
  if (layer.dataType === "signal") return "signal";
  return "reference";
}

/**
 * Check whether activating `proposedId` is compatible with the current
 * `activeIds` set, given the full layer `registry`.
 *
 * Only call this when TURNING A LAYER ON. Turning a layer off is always
 * allowed and must skip this check.
 *
 * Returns `{ allowed: true }` when the toggle is compatible, or
 * `{ allowed: false, hint: "<es-AR explanation>" }` when it is blocked.
 *
 * The hint references the conflicting layer's label so the UI can surface
 * a concrete, actionable message.
 */
export function checkCompatibility(
  activeIds: LayerId[],
  proposedId: LayerId,
  registry: readonly PanoramaLayer[],
): { allowed: boolean; hint?: string } {
  const proposed = registry.find((l) => l.id === proposedId);
  if (!proposed) return { allowed: true };

  const proposedRole = roleOf(proposed);

  // Reference layers are always compatible — unlimited.
  if (proposedRole === "reference") return { allowed: true };

  // Build a lookup from id → layer for the registry.
  const byId = new Map<LayerId, PanoramaLayer>(registry.map((l) => [l.id, l]));

  if (proposedRole === "base") {
    // At most 1 base layer active at a time — EXCEPT the two axes of a declared
    // bivariate pair (bivariate.ts BIVARIATE_PAIRS): a vetted density overlay
    // stacks over a rate surface (ppp × mordeduras reads exactly like
    // cobertura × zoonosis). The exception is per conflicting layer, so any
    // OTHER active base still blocks.
    for (const id of activeIds) {
      if (id === proposedId) continue; // already active — shouldn't happen when turning ON, but safe.
      const active = byId.get(id);
      if (!active) continue;
      if (roleOf(active) === "base") {
        if (isDeclaredBivariatePair(active.id, proposedId)) continue;
        return {
          allowed: false,
          hint: `Ya hay una capa base activa (${active.label}). Elegí una sola base; las señales y referencias van encima.`,
        };
      }
    }
    return { allowed: true };
  }

  // proposedRole === "signal": at most 1 signal active.
  for (const id of activeIds) {
    if (id === proposedId) continue;
    const active = byId.get(id);
    if (!active) continue;
    if (roleOf(active) === "signal") {
      return {
        allowed: false,
        hint: `Ya hay una señal activa (${active.label}). Solo se permite una señal a la vez.`,
      };
    }
  }
  return { allowed: true };
}
