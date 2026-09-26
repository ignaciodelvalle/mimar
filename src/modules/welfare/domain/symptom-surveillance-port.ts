// The surveillance port a welfare report uses for its "síntomas observados"
// (PO S7, 2026-09-26). Declared here, in the shape the welfare module needs
// ("mirror the shape, don't import the module"); the callers wire the events
// module's implementation (src/modules/events/application/surveillance/
// welfare-symptom-signals.ts). A SIGNAL only: no legal ENO row, no owner alert.

import type { EventPlace } from "@/lib/events/place-payload";

export type WelfareSymptomMatch = {
  matchedSymptomCodes: string[];
  alertedDiseaseCodes: string[];
  /** Opaque to the welfare module: handed back to emitSignals unchanged. */
  alerts: readonly unknown[];
};

export type WelfareSymptomSurveillance = {
  /** The matcher over the text, for the animal's species. Never throws. */
  match: (petId: string, freeText: string, tx: unknown) => Promise<WelfareSymptomMatch>;
  /**
   * One outbreak signal per alert, in the report's transaction. Returns the
   * post-commit flush of the authority notices.
   */
  emitSignals: (
    input: {
      petId: string;
      symptomEventId: string;
      match: WelfareSymptomMatch;
      place: EventPlace | null;
      now: Date;
    },
    tx: unknown,
  ) => Promise<() => Promise<void>>;
};
