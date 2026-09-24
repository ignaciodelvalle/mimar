// Shared types for the localities search application layer.
// Moved verbatim from app/actions/localities.ts (strangler 46/61).

import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";

export type SearchLocalitiesResult =
  | { results: LocalitySearchResult[] }
  | { error: "rate_limited" | "invalid_province" };
