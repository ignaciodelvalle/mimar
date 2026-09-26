// The welfare symptom port's wiring (PO S7), loaded LAZILY: the implementation
// pulls the event writers and the schema, and the welfare doors import this
// module at their top. A static import dragged that whole graph into every
// welfare action test (whose drizzle mocks do not model it). Memoised, so two
// concurrent callers share one load (vitest dynamic-import race, 2026-09).

type Impl = typeof import("./welfare-symptom-signals");

let loading: Promise<Impl> | null = null;
function load(): Promise<Impl> {
  if (loading === null) loading = import("./welfare-symptom-signals");
  return loading;
}

export const welfareSymptomSurveillance = {
  match: async (...args: Parameters<Impl["matchWelfareSymptoms"]>) =>
    (await load()).matchWelfareSymptoms(...args),
  emitSignals: async (...args: Parameters<Impl["emitWelfareSymptomSignals"]>) =>
    (await load()).emitWelfareSymptomSignals(...args),
};
