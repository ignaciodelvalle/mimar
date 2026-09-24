// Client-safe KPI label constants (registry-import fence, check-metric-labels.ts).
//
// A client component that needs ONE catalogued label must not import the full
// KPI_CATALOG (~2.5k lines of methodology prose — P2, perf sweep 2026-08-02)
// nor a fetcher module that drags DB imports into the client bundle. Labels
// here are the single source: the catalog entry imports its label FROM this
// module, so the string exists exactly once.

export const REUNIFICATION_RATE_LABEL_ES = "Tasa de reunificación";
