// The `payload_version` field every pet_events payload schema carries.
//
// Lives in its own module so a schema family can be split out of
// event-schemas.ts (which is at its file-size ratchet) without a circular
// import: the split module and event-schemas.ts both import from HERE, and
// neither imports the other's helper.
//
// Why the field exists: it is the foundation of the upcaster registry. Every
// schema bakes in `payload_version: z.literal(1).default(1)`, so new writes
// get version 1 automatically (the default fills in on parse). When a payload
// shape evolves, that schema's literal moves to 2 and an upcaster in
// `lib/events/event-upcasters.ts` maps v1 → v2 in the read path. Full contract:
// docs/superpowers/event-versioning.md.

import type { z } from "zod";
import { z as zod } from "zod";

/** Bakes the version field into a payload shape. */
export const withVersion = <T extends z.ZodRawShape>(shape: T) => ({
  payload_version: zod.literal(1).default(1),
  ...shape,
});
