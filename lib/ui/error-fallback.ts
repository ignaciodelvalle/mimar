// error-fallback — the ONE shared fallback string for a `catch` block that
// caught something other than an `Error` (so `err.message` isn't available).
//
// WHY (copy audit 2026-08-04, S10): five client forms independently
// hand-typed the identical
//   `err instanceof Error ? err.message : "Error desconocido"`
// fallback. Five copies of the same literal is exactly how a future typo
// ("Error desconosido" in one, "Error Desconocido" in another) or a future
// improvement (adding a recovery hint) lands in four of the five and misses
// the fifth. This is the one place that string lives now.
//
// This does NOT replace the dominant, better convention used at 40+ other
// call sites: `"No se pudo <verbo específico>: ${err.message ?? "error
// desconocido"}"`, which names the failed operation and is the right choice
// whenever the caller can state one. Reach for UNKNOWN_ERROR_FALLBACK only
// when there is no per-operation string to prefix it with — a fully generic
// top-level form error banner.
export const UNKNOWN_ERROR_FALLBACK = "Error desconocido";
