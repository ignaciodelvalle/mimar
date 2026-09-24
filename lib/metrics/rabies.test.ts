// Unit tests for the SHARED rabies numerator predicates (lib/metrics/rabies.ts).
//
// These assert on the GENERATED SQL shape (no DB) — the same PgDialect().sqlToQuery
// pattern scope.test.ts uses — so they are fast and pure. The point they pin:
// the "solo firmado por matrícula" narrowing (task #78 Part 3) is defined in ONE
// place (rabiesSignedByMatriculaCondition) and the EXISTS numerator only carries
// the vet-signed clause when signedOnly is set — so a self-reported dose is
// counted by default but NOT under the toggle.

import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { pets } from "@/db";
import {
  rabiesDoseQualifies,
  rabiesSignedByMatriculaCondition,
  rabiesVaccinatedExists,
} from "@/lib/metrics/rabies";

function render(clause: ReturnType<typeof sql>) {
  return new PgDialect().sqlToQuery(clause);
}

const WINDOW = {
  since: new Date("2025-07-08T00:00:00.000Z"),
  until: new Date("2026-07-08T00:00:00.000Z"),
};

describe("rabiesSignedByMatriculaCondition — the single vet-signed definition", () => {
  it("emits author_role = 'vet' AND author_verified = true over the given refs", () => {
    const { sql: text } = render(
      rabiesSignedByMatriculaCondition(
        sql`${pets.jurisdictionProvince}`, // stand-in refs — we only inspect the operator shape
        sql`${pets.jurisdictionLocality}`,
      ),
    );
    expect(text).toContain("= 'vet'");
    expect(text).toContain("= true");
    expect(text.toLowerCase()).toContain(" and ");
  });
});

describe("rabiesVaccinatedExists — optional vet-signed narrowing", () => {
  it("does NOT constrain author role/verification by default (every recorded dose counts)", () => {
    const { sql: text } = render(rabiesVaccinatedExists(sql`${pets.id}`, WINDOW));
    expect(text).toContain("event_type = 'vaccination_administered'");
    expect(text).not.toContain("author_role");
    expect(text).not.toContain("author_verified");
  });

  it("adds the shared vet-signed clause (aliased to pe_rabies) under signedOnly", () => {
    const { sql: text } = render(
      rabiesVaccinatedExists(sql`${pets.id}`, WINDOW, { signedOnly: true }),
    );
    // The numerator still requires a rabies vaccination event...
    expect(text).toContain("event_type = 'vaccination_administered'");
    // ...AND now the vet-signed clause, aliased to the EXISTS subquery table.
    expect(text).toContain("pe_rabies.author_role = 'vet'");
    expect(text).toContain("pe_rabies.author_verified = true");
  });
});

// ---------------------------------------------------------------------------
// Both amended fields, one probe (review 2026-08-22, M6)
// ---------------------------------------------------------------------------

describe("rabiesDoseQualifies — name AND expiry read through the overlay", () => {
  const REFS = {
    id: sql`pe.id`,
    payload: sql`pe.payload`,
    occurredAt: sql`pe.occurred_at`,
  };

  it("never reads next_due_at straight off the raw payload", () => {
    // The bug in one line: the vaccine name went through the overlay and the
    // booster date, right beside it, did not.
    const { sql: text } = render(rabiesDoseQualifies(REFS, WINDOW));
    expect(text).not.toContain("pe.payload->>'next_due_at'");
    expect(text).toContain("amended.next_due_at");
    expect(text).toContain("amended.vaccine_name");
  });

  it("resolves the latest amendment ONCE — one probe, both fields", () => {
    // This is the whole point of the lateral: it answers the performance
    // objection that kept the raw read alive, instead of paying a second
    // correlated sub-query on the hottest govt aggregate.
    const { sql: text } = render(rabiesDoseQualifies(REFS, WINDOW));
    const probes = text.match(/event_type = 'event_amended'/g) ?? [];
    expect(probes).toHaveLength(1);
    expect(text).toContain("LEFT JOIN LATERAL");
    // Ordering parity with the SQL twin in lib/infra/amendment-sql.ts: latest by
    // (occurred_at, recorded_at). Losing this makes the two disagree silently.
    expect(text).toContain("ORDER BY am.occurred_at DESC, am.recorded_at DESC");
  });

  it("falls back to the raw payload when nothing was amended", () => {
    const { sql: text } = render(rabiesDoseQualifies(REFS, WINDOW));
    expect(text).toContain("COALESCE");
    expect(text).toContain("(pe.payload)->>'vaccine_name'");
    expect(text).toContain("(pe.payload)->>'next_due_at'");
  });
});
