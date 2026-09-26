// Per-consumer read-path flags — localidades-por-id D1 (migration 0257).
//
// Each consumer that decides "which rows / which authority / which rule" by
// place moves from the NAME path to the ID path on its own, behind one row of
// public.place_read_flags:
//
//   name    today's behaviour (the default for every consumer);
//   shadow  serve the name path, compute the id path too, and record every
//           disagreement (lib/place/shadow.ts, shadow-sink.ts);
//   id      serve the id path.
//
// Flipping is an operator act after the parity sweep; rolling back is setting
// the row to 'name' again. Anything unexpected — a missing row, an unknown
// mode, a failed read — answers 'name': the name path is what production
// served before this change, so it is the only safe fallback.
//
// The consumer list is closed: the table's CHECK, this constant and the
// seeded rows are fenced equal (__tests__/place-read-flags-known-consumers).

import { db, placeReadFlags } from "@/db";

export const PLACE_READ_CONSUMERS = [
  "scope",
  "routing",
  "rules",
  "coverage",
  "public_filters",
  "panorama",
] as const;
export type PlaceReadConsumer = (typeof PLACE_READ_CONSUMERS)[number];

export const PLACE_READ_MODES = ["name", "shadow", "id"] as const;
export type PlaceReadMode = (typeof PLACE_READ_MODES)[number];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** A flip reaches every server instance within this long, without a deploy. */
const CACHE_TTL_MS = 30_000;

let cached: { at: number; modes: ReadonlyMap<string, string> } | null = null;

function isMode(value: unknown): value is PlaceReadMode {
  return typeof value === "string" && (PLACE_READ_MODES as readonly string[]).includes(value);
}

async function loadModes(exec: Executor): Promise<ReadonlyMap<string, string>> {
  const rows = await exec
    .select({ consumer: placeReadFlags.consumer, mode: placeReadFlags.mode })
    .from(placeReadFlags);
  return new Map(rows.map((r) => [r.consumer, r.mode]));
}

/**
 * The mode `consumer` runs in. With an explicit executor (a transaction, a
 * test) the table is read fresh; otherwise through a 30-second cache.
 */
export async function readPlaceFlag(
  consumer: PlaceReadConsumer,
  exec?: Executor,
): Promise<PlaceReadMode> {
  try {
    let modes: ReadonlyMap<string, string>;
    if (exec) {
      modes = await loadModes(exec);
    } else {
      const now = Date.now();
      if (!cached || now - cached.at > CACHE_TTL_MS) {
        cached = { at: now, modes: await loadModes(db) };
      }
      modes = cached.modes;
    }
    const mode = modes.get(consumer);
    return isMode(mode) ? mode : "name";
  } catch (error) {
    console.error("[place-flags] read failed, serving the name path", error);
    return "name";
  }
}

/** Tests only: forget the cached modes. */
export function resetPlaceFlagCache(): void {
  cached = null;
}
