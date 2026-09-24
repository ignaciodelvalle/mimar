// Shared types for the performed-by search application layer.
// Moved verbatim from app/actions/performed-by.ts (strangler 60/61).

import type { PerformedBySuggestion } from "@/lib/infra/performed-by-search";

export type SearchPerformedByResult =
  | { results: PerformedBySuggestion[] }
  | { error: "rate_limited" };
