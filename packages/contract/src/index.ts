// `@dim/contract` — the framework-free DIM domain contract.
//
// Everything exported here must be installable by a React Native app: no
// `next`, no `react`, no `drizzle-orm`, no `@/*` app imports, and no runtime
// dependencies at all.
//
// Subpath entry points exist so a consumer that only needs the event
// vocabulary does not have to name the visualization module:
//   import { EVENT_TYPES } from "@dim/contract/events";
//   import { SCALE_BLUE_SEQ } from "@dim/contract/viz";
//   import { createIntakeInputSchema } from "@dim/contract/input";
//   import type { PublicCredentialV1 } from "@dim/contract/api";
//   import { breedsForSpecies } from "@dim/contract/reference";
//   import { deepLinkPath } from "@dim/contract/links";
//   import { sortForDisplay } from "@dim/contract/notifications";
//   import { LN_COLORS } from "@dim/contract/tokens";
//   import { PET_PROFILE_ICONS } from "@dim/contract/icons";
//
// `input` is the one entry point with a runtime dependency (zod). A consumer
// that only reads the event vocabulary, the scales, the static catalogs, the
// `/api/v1` wire shapes or the deep-link table never loads it.
export * from "./api/index.ts";
export * from "./events/index.ts";
export * from "./icons/index.ts";
export * from "./input/index.ts";
export * from "./links/index.ts";
export * from "./notifications/index.ts";
export * from "./reference/index.ts";
export * from "./tokens/index.ts";
export * from "./viz/index.ts";
