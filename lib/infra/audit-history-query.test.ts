// Unit tests for lib/infra/audit-history-query.ts (#26 admin↔gob drift
// unification, D1).
//
// buildAuditHistoryWhere is pure (no DB) — rendered via
// PgDialect().sqlToQuery, same pattern as lib/metrics/scope.test.ts.
// resolveAuditHistoryActorOptions IS async and touches the DB on some
// branches (a scoped govt fetch, or an actorFilter not already on the page) —
// only its DB-FREE branches are exercised here (empty govt scope; admin
// branch where the filter is already present on the page), so this file
// stays DB-free like its siblings.

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  type AuditHistoryScope,
  buildAuditHistoryWhere,
  resolveAuditHistoryActorOptions,
} from "@/lib/infra/audit-history-query";

function render(clause: ReturnType<typeof buildAuditHistoryWhere>) {
  if (!clause) return { sql: "", params: [] as unknown[] };
  return new PgDialect().sqlToQuery(clause);
}

const ADMIN: AuditHistoryScope = { kind: "admin" };
const GOVT_EMPTY: AuditHistoryScope = { kind: "govt", actorIds: [] };
const GOVT_SCOPED: AuditHistoryScope = {
  kind: "govt",
  actorIds: ["11111111-2222-3333-4444-555555555555"],
};

const NO_FILTERS = { actionFilters: [], actorFilter: null, cursor: null };

describe("buildAuditHistoryWhere — admin scope", () => {
  it("returns undefined (no WHERE) for admin, no filters, page 1", () => {
    expect(buildAuditHistoryWhere(ADMIN, NO_FILTERS)).toBeUndefined();
  });

  it("never restricts by actorUserId for admin, even unfiltered", () => {
    const { sql: text } = render(
      buildAuditHistoryWhere(ADMIN, { ...NO_FILTERS, actionFilters: ["request_approved"] }),
    );
    // Only the action condition should appear — no actor_user_id predicate
    // sourced from the SCOPE (an explicit actorFilter would still add one,
    // but none is set here).
    expect(text).toContain("action");
    expect(text).not.toContain("actor_user_id");
  });
});

describe("buildAuditHistoryWhere — govt scope (#26 D1 parity)", () => {
  it("fails CLOSED for an empty jurisdiction-derived actor scope", () => {
    const { sql: text } = render(buildAuditHistoryWhere(GOVT_EMPTY, NO_FILTERS));
    expect(text).toMatch(/false/);
  });

  it("restricts actorUserId to the scoped actor ids", () => {
    const { sql: text, params } = render(buildAuditHistoryWhere(GOVT_SCOPED, NO_FILTERS));
    expect(text).toContain("actor_user_id");
    expect(params).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("applies the SAME action/actor/date filters as admin, plus the scope predicate", () => {
    const filters = {
      actionFilters: ["request_approved" as const],
      actorFilter: "22222222-3333-4444-5555-666666666666",
      fromDate: new Date("2026-01-01T00:00:00.000Z"),
      toDate: new Date("2026-07-01T00:00:00.000Z"),
      cursor: null,
    };
    const admin = render(buildAuditHistoryWhere(ADMIN, filters));
    const govt = render(buildAuditHistoryWhere(GOVT_SCOPED, filters));
    // Every admin param must still be present in the govt query.
    for (const p of admin.params) expect(govt.params).toContain(p);
    // The govt query additionally carries the actor-scope id.
    expect(govt.params).toContain("11111111-2222-3333-4444-555555555555");
    expect(admin.params).not.toContain("11111111-2222-3333-4444-555555555555");
  });
});

describe("buildAuditHistoryWhere — cursor appended last", () => {
  it("keeps the cursor comparison after the user-facing filters", () => {
    const { sql: text } = render(
      buildAuditHistoryWhere(ADMIN, {
        actionFilters: ["request_approved"],
        actorFilter: null,
        cursor: { ts: "2026-07-01T00:00:00.000Z", id: "11111111-2222-3333-4444-555555555555" },
      }),
    );
    const actionIdx = text.indexOf("action");
    const cursorIdx = text.indexOf("performed_at");
    expect(actionIdx).toBeGreaterThanOrEqual(0);
    expect(cursorIdx).toBeGreaterThan(actionIdx);
  });
});

describe("resolveAuditHistoryActorOptions — DB-free branches", () => {
  it("returns an empty list for a govt scope with no active assignments", async () => {
    const options = await resolveAuditHistoryActorOptions(GOVT_EMPTY, [], new Map(), null);
    expect(options).toEqual([]);
  });

  it("derives options from the current page for admin — no DB call when actorFilter is already listed", async () => {
    const namesById = new Map([
      ["u1", "Ana Pérez"],
      ["u2", "Beto López"],
    ]);
    const options = await resolveAuditHistoryActorOptions(ADMIN, ["u1", "u2"], namesById, "u1");
    expect(options).toEqual([
      { id: "u1", name: "Ana Pérez" },
      { id: "u2", name: "Beto López" },
    ]);
  });

  it("sorts admin page options alphabetically (es-AR)", async () => {
    const namesById = new Map([
      ["u1", "Zoe"],
      ["u2", "Ana"],
    ]);
    const options = await resolveAuditHistoryActorOptions(ADMIN, ["u1", "u2"], namesById, null);
    expect(options.map((o) => o.name)).toEqual(["Ana", "Zoe"]);
  });
});
