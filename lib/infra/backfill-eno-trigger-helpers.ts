// Pure helpers for the ENO trigger backfill script.
//
// Extracted so they can be unit-tested without a DB connection.
// All functions are side-effect-free — no imports from "@/db".

import { diseaseCodeToEnoCode, isEnoCode } from "@/src/modules/surveillance/domain/eno-catalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The minimal payload shape the backfill script reads from pet_events rows.
 * Mirrors the JSONB `payload` column — all fields are `unknown` at the DB
 * boundary; the helpers extract and validate what they need.
 */
export type EventPayload = Record<string, unknown>;

/**
 * Parsed CLI flags for `scripts/backfill-eno-trigger.ts`.
 */
export type BackfillFlags = {
  dryRun: boolean;
  since: Date | null;
  until: Date;
  limit: number;
};

// ---------------------------------------------------------------------------
// isEnoEligible
// ---------------------------------------------------------------------------

/**
 * Returns true when a pet_event payload represents an ENO-eligible disease
 * diagnosis that the backfill should consider for notification replay.
 *
 * Conditions (both required):
 *   1. payload.sub_kind === 'disease_diagnosis'
 *   2. payload.disease_code bridges to a known ENO catalog code via
 *      `diseaseCodeToEnoCode` + `isEnoCode`
 *
 * This is the single gating predicate — it mirrors the first two early-exit
 * checks in `processEnoEventTrigger` (minus the DB calls).
 */
export function isEnoEligible(payload: EventPayload): boolean {
  if (payload.sub_kind !== "disease_diagnosis") return false;

  const rawCode = typeof payload.disease_code === "string" ? payload.disease_code : null;
  if (!rawCode) return false;

  return isEnoCode(diseaseCodeToEnoCode(rawCode));
}

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

/**
 * Parses CLI arguments into a typed `BackfillFlags` object.
 *
 * Accepted flags:
 *   --dry-run           boolean, default false
 *   --since YYYY-MM-DD  lower bound (inclusive), default null (no bound)
 *   --until YYYY-MM-DD  upper bound (exclusive), default now
 *   --limit N           max candidates to process, default 1000
 *
 * Invalid `--since` / `--until` values are ignored (default is used).
 * Invalid `--limit` values are ignored (default 1000 is used).
 */
export function parseFlags(argv: string[]): BackfillFlags {
  let dryRun = false;
  let since: Date | null = null;
  let until: Date = new Date();
  let limit = 1000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--since") {
      const raw = argv[i + 1];
      if (raw) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) {
          since = d;
        }
        i++;
      }
    } else if (arg === "--until") {
      const raw = argv[i + 1];
      if (raw) {
        const d = new Date(raw);
        if (!Number.isNaN(d.getTime())) {
          until = d;
        }
        i++;
      }
    } else if (arg === "--limit") {
      const raw = argv[i + 1];
      if (raw) {
        const n = Number.parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) {
          limit = n;
        }
        i++;
      }
    }
  }

  return { dryRun, since, until, limit };
}
