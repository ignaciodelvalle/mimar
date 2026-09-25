// The `place` a place-bearing event payload keeps — as ENTERED and as RESOLVED.
//
// localidades-por-id (P2: never lose an event's origin place). The flat
// `jurisdiction_*` keys some payloads carry are two display strings: they say
// neither what was entered nor which catalogue row it resolved to, if any. This
// object says both, and it is what a later re-resolution (a catalogue rename, an
// admin working the unresolved queue) is compared against — never rewritten:
// a later resolution is a side record, not an edit of this payload.
//
//   entered  — the province, locality NAME and INDEC id the person or client
//              gave, as given. Not the point or the address: those live on the
//              event row (`location_lat`/`location_lng`, `location_description`)
//              under the erasure policy in lib/events/payload-privacy.ts, and a
//              second copy here would be personal data that policy cannot reach.
//   resolved — the ONE `ar_localities` row it resolved to, its province code and
//              HOW (lib/domain/place.ts), or `null` when nothing named exactly
//              one row. Never a guessed homonym.
//
// Optional on every schema that accepts it: events written before it existed
// validate unchanged (append-only history, forward-only change).

import { z } from "zod";

import { PLACE_METHODS } from "@/lib/domain/place";

export const eventPlaceSchema = z
  .object({
    entered: z
      .object({
        province: z.string().nullable(),
        locality: z.string().nullable(),
        indec_id: z.string().nullable(),
      })
      .strict(),
    resolved: z
      .object({
        locality_id: z.string().uuid(),
        province_code: z.string().regex(/^AR-[A-Z]$/),
        method: z.enum(PLACE_METHODS),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type EventPlace = z.infer<typeof eventPlaceSchema>;
