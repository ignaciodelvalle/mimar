// SightingActionState for the anonymous pet sighting report use-case.

export type SightingActionState = {
  ok: boolean;
  error: string | null;
  /** Non-fatal warning shown when photo upload failed but sighting was saved. */
  warning?: string | null;
};
