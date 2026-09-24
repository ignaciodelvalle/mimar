// Shared types for the slot-materialization application layer.
// Moved verbatim from app/actions/slot-materialization.ts (strangler 28/61).

export type MaterializeNowResult =
  | { rulesProcessed: number; slotsInserted: number }
  | { error: string };

export type BlockSlotResult = { ok: true } | { error: string };
