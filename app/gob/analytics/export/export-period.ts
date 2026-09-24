// Export period resolution — ONE vocabulary, ONE resolver (RA-2 F11).
//
// Lives outside actions.ts because that file is "use server" (every runtime
// export there must be an async function, so neither the error class nor the
// default-preset constant could live beside the action) and because the rule
// this module encodes deserves a unit test that does not drag in Resend, the
// DB client, and the whole export pipeline.
//
// The defect this replaces: actions.ts hand-rolled its own branch set over the
// period values — it recognised "7d" / "90d" / "1y", where "1y" is produced by
// NOTHING in the codebase, and silently defaulted everything else to 30 days.
// <PeriodPicker> actually emits "7d" | "30d" | "90d" | "trailing12m" | "ytd" |
// "custom". So an operator who picked "Últimos 12 meses" or "Año en curso" got
// a working download link for a 30-day file, and — the serious half — the
// audit_log row for that government export persisted the 30-day since/until as
// though it were the window they had requested. A falsified audit trail is
// worse than a failed export.

import { type AnalyticsPeriod, resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { type PeriodPresetId, isPeriodPresetId } from "@/lib/metrics/period-presets";

/**
 * Default preset for the analytics export surface.
 *
 * Single-sourced here so the server page's fallback, the <PeriodPicker>'s
 * `defaultPreset`, and this resolver cannot disagree about what "no period was
 * chosen" means — a disagreement is exactly how the mislabelled window got
 * into the audit trail in the first place.
 */
export const EXPORT_DEFAULT_PRESET: PeriodPresetId = "30d";

/** Thrown when the posted period is not a value the canonical vocabulary contains. */
export class UnknownExportPeriodError extends Error {
  readonly received: string;

  constructor(received: string) {
    super(`Unknown export period preset: ${JSON.stringify(received)}`);
    this.name = "UnknownExportPeriodError";
    this.received = received;
  }
}

/**
 * Resolve the requested export window from the posted form fields.
 *
 * Validates against the canonical `PERIOD_PRESET_IDS` and delegates the actual
 * date maths to `resolveAnalyticsPeriod` — the same resolver every /gob
 * dashboard page uses — so the rows in the file, the window in the link, and
 * the `since`/`until` in the audit row always describe the SAME period.
 *
 * An absent period falls back to `EXPORT_DEFAULT_PRESET`. A present but
 * unrecognised value THROWS: that means the two vocabularies drifted again, and
 * a loud failure the operator can see beats a quiet lie in the audit trail.
 */
export function resolveExportPeriod(formData: FormData): AnalyticsPeriod {
  const rawPreset = formData.get("period");
  const preset = typeof rawPreset === "string" ? rawPreset.trim() : "";
  const fromStr = formData.get("from");
  const toStr = formData.get("to");

  const requested = preset === "" ? EXPORT_DEFAULT_PRESET : preset;
  if (!isPeriodPresetId(requested)) {
    throw new UnknownExportPeriodError(requested);
  }

  return resolveAnalyticsPeriod({
    period: requested,
    from: typeof fromStr === "string" ? fromStr : undefined,
    to: typeof toStr === "string" ? toStr : undefined,
  });
}
