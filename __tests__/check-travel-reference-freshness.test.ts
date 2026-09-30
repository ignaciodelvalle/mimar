// Offline guard for the travel reference freshness fence
// (scripts/check-travel-reference-freshness.ts) and the shared freshnessOf.
//
// RED CONTROLS: every structural defect the fence exists for must fire on a
// synthetic registry, and the calendar must NEVER fire an error — only a
// warning. The shipped registry is checked at its verification date.

import { describe, expect, it } from "vitest";

import { freshnessOf } from "@/lib/domain/travel-freshness";
import type { Corridor } from "@/lib/reference/cross-border-corridors";
import {
  type ReferenceRegistry,
  SHIPPED_REGISTRY,
  evaluateReferenceFreshness,
} from "../scripts/check-travel-reference-freshness";
import { travelReferenceRows } from "../scripts/travel-reference-json";

const VERIFIED_ON = new Date("2026-09-30T12:00:00Z");

function withCorridor(patch: Partial<Corridor>): ReferenceRegistry {
  const [first, ...rest] = SHIPPED_REGISTRY.corridors;
  return { ...SHIPPED_REGISTRY, corridors: [{ ...first, ...patch }, ...rest] };
}

describe("freshnessOf", () => {
  const meta = { reviewBy: "2026-12-29", verification: "verified" as const };

  it("is fresh up to and including the review date", () => {
    expect(freshnessOf(meta, new Date("2026-12-29T23:00:00Z"))).toBe("fresh");
  });

  it("is expired the day after", () => {
    expect(freshnessOf(meta, new Date("2026-12-30T00:00:00Z"))).toBe("expired");
  });

  it("is unverified whatever the date — recency does not confirm anything", () => {
    expect(freshnessOf({ ...meta, verification: "unverified" }, VERIFIED_ON)).toBe("unverified");
  });
});

describe("the shipped registry", () => {
  it("is well formed on the day it was verified, with nothing expired", () => {
    const verdict = evaluateReferenceFreshness(SHIPPED_REGISTRY, VERIFIED_ON);
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toEqual([]);
    // Non-vacuity: 5 corridors, 20 airlines, their leaves and the breed list.
    expect(verdict.checked).toBeGreaterThan(150);
  });

  it("a year later only WARNS — the calendar never fails the fence", () => {
    const verdict = evaluateReferenceFreshness(SHIPPED_REGISTRY, new Date("2027-10-01T00:00:00Z"));
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.length).toBe(verdict.checked);
  });

  it("exports one provenance row per entry", () => {
    const rows = travelReferenceRows();
    expect(rows.length).toBe(evaluateReferenceFreshness(SHIPPED_REGISTRY, VERIFIED_ON).checked);
    expect(rows.every((r) => r.sourceUrl?.startsWith("https://"))).toBe(true);
  });
});

describe("structural errors fail", () => {
  it("a non-https or missing source", () => {
    const verdict = evaluateReferenceFreshness(
      withCorridor({ sourceUrl: "http://example.gov" }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/sourceUrl missing or not https/);
  });

  it("a malformed date", () => {
    const verdict = evaluateReferenceFreshness(
      withCorridor({ lastVerifiedAt: "30/09/2026" }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/lastVerifiedAt missing or not YYYY-MM-DD/);
  });

  it("a review date before the verification", () => {
    const verdict = evaluateReferenceFreshness(
      withCorridor({ reviewBy: "2026-09-01" }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/is before lastVerifiedAt/);
  });

  it("a review date beyond the TTL", () => {
    const verdict = evaluateReferenceFreshness(
      withCorridor({ reviewBy: "2027-09-30" }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/TTL 180 for country/);
  });

  it("a verification date in the future", () => {
    const verdict = evaluateReferenceFreshness(
      withCorridor({ lastVerifiedAt: "2026-10-15", reviewBy: "2027-01-15" }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/is in the future/);
  });

  it("a declared rule with no provenance (a bare value, not an envelope)", () => {
    const [first] = SHIPPED_REGISTRY.corridors;
    const bare = { value: 10 } as unknown as NonNullable<
      Corridor["rules"]["document_issuance_window_days"]
    >;
    const verdict = evaluateReferenceFreshness(
      withCorridor({ rules: { ...first.rules, document_issuance_window_days: bare } }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(/rules\.document_issuance_window_days: sourceUrl/);
  });

  it("a rule envelope that lost its review date", () => {
    const [first] = SHIPPED_REGISTRY.corridors;
    const envelope = first.rules.rabies_vaccination_to_travel_wait_days;
    if (!envelope) throw new Error("fixture: the first corridor declares a rabies wait");
    const verdict = evaluateReferenceFreshness(
      withCorridor({
        rules: {
          ...first.rules,
          rabies_vaccination_to_travel_wait_days: { ...envelope, reviewBy: "" },
        },
      }),
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(
      /rules\.rabies_vaccination_to_travel_wait_days: reviewBy missing/,
    );
  });

  it("an unverified value without a note", () => {
    const registry: ReferenceRegistry = {
      ...SHIPPED_REGISTRY,
      brachycephalic: { ...SHIPPED_REGISTRY.brachycephalic, note: undefined },
    };
    const verdict = evaluateReferenceFreshness(registry, VERIFIED_ON);
    expect(verdict.errors).toEqual(["brachycephalic list: unverified without a note saying why"]);
  });

  it("an airline leaf beyond the 90-day TTL", () => {
    const [first, ...rest] = SHIPPED_REGISTRY.airlines;
    const cabin = first.modalities.cabin;
    if (!cabin) throw new Error("fixture: the first airline has a cabin rule");
    const patched = {
      ...first,
      modalities: {
        ...first.modalities,
        cabin: { ...cabin, offered: { ...cabin.offered, reviewBy: "2027-03-29" } },
      },
    };
    const verdict = evaluateReferenceFreshness(
      { ...SHIPPED_REGISTRY, airlines: [patched, ...rest] },
      VERIFIED_ON,
    );
    expect(verdict.errors.join("\n")).toMatch(
      /cabin\.offered: reviewBy is 180 days .*TTL 90 for airline/,
    );
  });
});
