// Shared outbox list filter/query builder (#26 admin↔gob drift unification,
// D3).
//
// app/admin/outbox/page.tsx and app/gob/outbox/page.tsx used to hand-roll the
// SAME filter-building SQL twice (gob/outbox's header literally said "Adapted
// from /admin/outbox/page.tsx"), duplicating OUTBOX_PAGE_LIMIT and
// VALID_PROVINCE_NAMES along with it. The two forks differed ONLY by one
// extra jurisdiction WHERE clause on the govt side. This module is now the
// single source of both constants and the WHERE-clause assembly.
//
// PARITY CONTRACT: buildOutboxWhere(filters, opts) must produce the exact
// same conditions (in the same order) that each page's inline builder used
// to produce for the same inputs — the ONLY difference is the jurisdiction
// predicate, controlled by `opts.jurisdiction`:
//   - `undefined`            → admin / universal — NO jurisdiction clause at
//                              all (today's /admin/outbox behavior).
//   - a (possibly empty) array → govt — a jurisdiction clause is ALWAYS
//                              applied. A non-empty array scopes to those
//                              (province, locality) pairs via
//                              jurisdictionPairClause (whole-province
//                              subsumption, same as every other jurisdiction-
//                              scoped fetcher). An EMPTY array fails CLOSED
//                              (`sql\`false\`` — matches nothing), never
//                              "no restriction": today's /gob/outbox page
//                              never reaches the query with an empty
//                              jurisdictions array (its hasAccess gate bails
//                              out first with a "Sin acceso" screen), so this
//                              fail-closed branch is unreachable via either
//                              existing page today — it is defensive parity
//                              for any FUTURE caller of this shared builder,
//                              not a behavior change for the two current
//                              pages. See the unit tests for the "applies the
//                              jurisdiction predicate iff scope is provided"
//                              assertion this contract implies.

import { type SQL, and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { eventNotificationOutbox } from "@/db";
import type { OutboxStatus, OutboxTargetKind } from "@/db";
import { jurisdictionPairClause, syntheticRowExclusion } from "@/lib/metrics/scope";
import { PROVINCES } from "@/lib/reference/ar-provincias";
import { keysetWhere } from "@/lib/utils/keyset-pagination";
import { trimmedSearchParam } from "@/lib/utils/search-params";

/** Set of canonical province names for filter validation. */
export const VALID_PROVINCE_NAMES = new Set<string>(PROVINCES.map((p) => p.name));

/** Page size for both /admin/outbox and /gob/outbox. */
export const OUTBOX_PAGE_LIMIT = 200;

const VALID_STATUS_VALUES: readonly string[] = ["pending", "delivered", "failed"];
const VALID_TARGET_KIND_VALUES: readonly string[] = [
  "govt_webhook",
  "eno_authority",
  "audit_export",
  "internal_dashboard",
];

// ---------------------------------------------------------------------------
// Presets — a URL alias (`?preset=`) for a curated view of the queue, so a nav
// entry can deep-link it. ONE preset today:
//
//   eno — the LEGAL-notification queue: rows bound for an external authority
//         (`eno_authority` — the ENO catalog's notifiable diseases, each with
//         a statutory `notifyHours`; `govt_webhook` — the jurisdiction's own
//         receiving system). Ordered by legal deadline, breached first — see
//         outboxOrderBy. `audit_export` / `internal_dashboard` are OUR
//         bookkeeping, not a legal duty, so they stay out of it.
//
// A preset is a FILTER + an ORDER, never a second page: both /gob/outbox and
// /admin/outbox read it through the same builder, so the twins cannot drift.
// ---------------------------------------------------------------------------

export const OUTBOX_PRESET_IDS = ["eno"] as const;
export type OutboxPresetId = (typeof OUTBOX_PRESET_IDS)[number];

/** The target kinds that carry a LEGAL notification duty (the `eno` preset). */
export const ENO_PRESET_TARGET_KINDS: readonly OutboxTargetKind[] = [
  "eno_authority",
  "govt_webhook",
];

/** `?preset=` → a known preset id, or null for anything else (unknown = no preset, never an error). */
export function parseOutboxPreset(
  raw: string | string[] | null | undefined,
): OutboxPresetId | null {
  const value = trimmedSearchParam(raw ?? undefined);
  return value && (OUTBOX_PRESET_IDS as readonly string[]).includes(value)
    ? (value as OutboxPresetId)
    : null;
}

export interface OutboxQueryFilters {
  status?: string;
  target_kind?: string;
  breach?: string;
  province?: string;
  /** A curated view (see the Presets block above). Null/undefined = the whole bandeja. */
  preset?: OutboxPresetId | null;
}

/** The raw searchParams shape both outbox pages receive (a repeated key arrives as string[]). */
export type OutboxSearchParams = {
  status?: string | string[];
  target_kind?: string | string[];
  breach?: string | string[];
  province?: string | string[];
  preset?: string | string[];
};

/**
 * Parse the page's raw searchParams into the builder's filters — ONCE, for
 * both twins. Q1-safe: a repeated key (`?status=a&status=b`) hands Next a
 * string[], which a raw `.trim()` used to turn into a 500; trimmedSearchParam
 * collapses it. An unknown `?preset=` is simply no preset.
 */
export function parseOutboxFilters(sp: OutboxSearchParams): OutboxQueryFilters {
  return {
    status: trimmedSearchParam(sp.status),
    target_kind: trimmedSearchParam(sp.target_kind),
    breach: trimmedSearchParam(sp.breach),
    province: trimmedSearchParam(sp.province),
    preset: parseOutboxPreset(sp.preset),
  };
}

export interface BuildOutboxWhereOptions {
  /**
   * Jurisdiction scope. `undefined` = admin/universal (no jurisdiction
   * clause). A (possibly empty) array = govt, scoped to those
   * (province, locality) pairs — see the module doc comment for the
   * empty-array fail-closed contract.
   */
  jurisdiction?: ReadonlyArray<{ province: string; locality: string }>;
  cursor: { ts: string; id: string } | null;
}

/**
 * Builds the event_notification_outbox WHERE clause. Order mirrors the exact
 * assembly both /admin/outbox and /gob/outbox used before this extraction:
 * jurisdiction (govt only) → status → target_kind → province → breach →
 * keyset cursor. Exported so pages can call it and unit tests can verify the
 * output shape (incl. the jurisdiction-predicate parity contract) without
 * hitting the DB.
 */
export function buildOutboxWhere(
  filters: OutboxQueryFilters,
  opts: BuildOutboxWhereOptions,
): SQL | undefined {
  const conditions: SQL[] = [];

  // --- Jurisdiction (privacy invariant) ---
  // Applied FIRST, exactly as /gob/outbox did. See module doc comment for the
  // undefined-vs-empty-array contract.
  if (opts.jurisdiction !== undefined) {
    const jurisClause =
      jurisdictionPairClause(
        [...opts.jurisdiction],
        sql`${eventNotificationOutbox.targetJurisdictionProvince}`,
        sql`${eventNotificationOutbox.targetJurisdictionLocality}`,
      ) ?? sql`false`;
    conditions.push(jurisClause);
    // T1-P1: the govt twin never lists a notification about a synthetic
    // (seed-tagged) pet. This is the one intended difference from /admin/outbox
    // besides the jurisdiction itself — admin keeps the whole queue for demos.
    conditions.push(syntheticRowExclusion.outbox());
  }

  // --- User-facing filter conditions (identical on both surfaces) ---
  // When breach=yes, status is implied to be 'pending' — skip the standalone
  // status condition to avoid the always-false contradiction (e.g.
  // status='delivered' AND status='pending').
  if (filters.status && filters.breach !== "yes" && VALID_STATUS_VALUES.includes(filters.status)) {
    conditions.push(eq(eventNotificationOutbox.status, filters.status as OutboxStatus));
  }
  if (filters.target_kind && VALID_TARGET_KIND_VALUES.includes(filters.target_kind)) {
    conditions.push(
      eq(eventNotificationOutbox.targetKind, filters.target_kind as OutboxTargetKind),
    );
  }
  // Preset: the legal-notification queue narrows to the external-authority
  // target kinds. AND-composed with a single target_kind filter (never OR'd):
  // a kind outside the preset then matches nothing, which is the honest
  // answer to "show me audit exports inside the legal queue".
  if (filters.preset === "eno") {
    conditions.push(inArray(eventNotificationOutbox.targetKind, [...ENO_PRESET_TARGET_KINDS]));
  }
  // Province: only push condition when the value is a known canonical province name.
  if (filters.province && VALID_PROVINCE_NAMES.has(filters.province)) {
    conditions.push(eq(eventNotificationOutbox.targetJurisdictionProvince, filters.province));
  }
  // breach filter: "yes" → pending AND slaDueAt < now() (skip separate status
  // condition — breach already implies pending, combining them produces
  // status='delivered' AND status='pending' which is always-false); "no" →
  // NOT (pending AND slaDueAt < now()).
  if (filters.breach === "yes") {
    conditions.push(lt(eventNotificationOutbox.slaDueAt, sql`now()`));
    conditions.push(eq(eventNotificationOutbox.status, "pending"));
  } else if (filters.breach === "no") {
    conditions.push(
      sql`NOT (${eventNotificationOutbox.status} = 'pending' AND ${eventNotificationOutbox.slaDueAt} < now())`,
    );
  }

  // --- Keyset predicate — AND-composed last, so limit is applied after narrowing. ---
  const cursorClause = keysetWhere(
    eventNotificationOutbox.createdAt,
    eventNotificationOutbox.id,
    opts.cursor,
  );
  if (cursorClause) conditions.push(cursorClause);

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * ORDER BY for the list, by preset.
 *
 *   - no preset → recency: (created_at DESC, id DESC) — the order the keyset
 *     cursor paginates over (keysetWhere compares the same (ts, id) pair).
 *   - `eno`     → the legal queue: rows ALREADY past their statutory deadline
 *     first (status = 'pending' AND sla_due_at < now()), then the nearest
 *     deadline first (sla_due_at ASC), id ASC as the tie-break. A delivered
 *     or failed row never "breaches", so it sorts after every open breach
 *     regardless of its own deadline.
 *
 * Exported so the two twins and the unit test read ONE definition of "what
 * comes first in the legal queue".
 */
export function outboxOrderBy(preset: OutboxPresetId | null | undefined): SQL[] {
  if (preset === "eno") {
    return [
      desc(
        sql`(${eventNotificationOutbox.status} = 'pending' AND ${eventNotificationOutbox.slaDueAt} < now())`,
      ),
      asc(eventNotificationOutbox.slaDueAt),
      asc(eventNotificationOutbox.id),
    ];
  }
  return [desc(eventNotificationOutbox.createdAt), desc(eventNotificationOutbox.id)];
}

/**
 * Keyset cursors are minted over the recency order only — a cursor's
 * (created_at, id) pair says nothing about a row's position in a
 * deadline-ordered list. A preset view therefore takes NO cursor and renders
 * ONE page (OUTBOX_PAGE_LIMIT rows, nearest deadlines first) with an honest
 * "showing the N nearest" note when more exist, instead of a "más antiguos"
 * link that would silently re-sort on the next page.
 */
export function outboxSupportsKeyset(preset: OutboxPresetId | null | undefined): boolean {
  return !preset;
}
