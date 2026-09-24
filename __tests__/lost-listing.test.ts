// Pure-function tests for the lost-listing shared module — the URL codec
// and the time-bucket / urgency helpers. No DB; safe to run without a
// local Postgres.
//
// The query side (`queryLostListing`) needs a DB fixture and lives in a
// follow-up integration test once seed data is in place.

import { describe, expect, it } from "vitest";

import {
  type LostListingCursor,
  type LostListingFilters,
  buildSearchParams,
  lostTimeLabel,
  lostUrgencyFor,
  parseSearchParams,
} from "@/lib/infra/lost-listing";

describe("lib/lost-listing — parseSearchParams", () => {
  it("returns empty filters when no params are present", () => {
    const { filters, cursor } = parseSearchParams({});
    expect(filters).toEqual({});
    expect(cursor).toBeNull();
  });

  it("picks up species, provincia, localidad, color", () => {
    const { filters } = parseSearchParams({
      species: "dog",
      provincia: "Buenos Aires",
      localidad: "La Plata",
      color: "negro",
    });
    expect(filters.species).toBe("dog");
    expect(filters.province).toBe("Buenos Aires");
    expect(filters.locality).toBe("La Plata");
    expect(filters.color).toBe("negro");
  });

  it("parses the visto bucket and ignores invalid values", () => {
    expect(parseSearchParams({ visto: "today" }).filters.visto).toBe("today");
    expect(parseSearchParams({ visto: "week" }).filters.visto).toBe("week");
    expect(parseSearchParams({ visto: "month" }).filters.visto).toBe("month");
    // Anything else is dropped (defensive against URL noise).
    expect(parseSearchParams({ visto: "anytime" }).filters.visto).toBeUndefined();
  });

  it("parses the criticidad chip into the criticality filter", () => {
    expect(parseSearchParams({ criticidad: "critical" }).filters.criticality).toBe("critical");
    // Values other than 'critical' are dropped — there is no chip for them.
    expect(parseSearchParams({ criticidad: "recent" }).filters.criticality).toBeUndefined();
  });

  it("parses the boolean quick chips", () => {
    const { filters } = parseSearchParams({ con_chip: "true", castrado: "true" });
    expect(filters.hasMicrochip).toBe(true);
    expect(filters.isSterilized).toBe(true);
  });

  it("ignores non-'true' values on boolean chips", () => {
    // Defensive: a stale URL with `?con_chip=false` shouldn't accidentally
    // mean "filter for pets WITHOUT chip" — that's not what the chip means.
    const { filters } = parseSearchParams({ con_chip: "false", castrado: "1" });
    expect(filters.hasMicrochip).toBeUndefined();
    expect(filters.isSterilized).toBeUndefined();
  });

  it("parses the cursor when both parts are present, drops it otherwise", () => {
    const { cursor: a } = parseSearchParams({
      cursor: "2026-05-26T12:00:00.000Z|abc-123",
    });
    expect(a).toEqual({ markedLostAt: "2026-05-26T12:00:00.000Z", id: "abc-123" });
    expect(parseSearchParams({ cursor: "bogus" }).cursor).toBeNull();
    expect(parseSearchParams({ cursor: "|" }).cursor).toBeNull();
  });

  it("picks the first value when a param is supplied as an array", () => {
    const { filters } = parseSearchParams({
      species: ["dog", "cat"],
      provincia: ["CABA"],
    });
    expect(filters.species).toBe("dog");
    expect(filters.province).toBe("CABA");
  });
});

describe("lib/lost-listing — buildSearchParams", () => {
  it("produces an empty string for an empty filter set", () => {
    expect(buildSearchParams({}, null).toString()).toBe("");
  });

  it("roundtrips the full filter shape", () => {
    const filters: LostListingFilters = {
      species: "cat",
      province: "Mendoza",
      locality: "Godoy Cruz",
      color: "atigrado",
      visto: "week",
      criticality: "critical",
      hasMicrochip: true,
      isSterilized: true,
    };
    const cursor: LostListingCursor = { markedLostAt: "2026-05-26T08:00:00.000Z", id: "x9k2" };
    const params = buildSearchParams(filters, cursor);
    const round = parseSearchParams(Object.fromEntries(params.entries()));
    expect(round.filters).toEqual(filters);
    expect(round.cursor).toEqual(cursor);
  });

  it("omits boolean flags when false / undefined", () => {
    const out = buildSearchParams(
      { species: "dog", hasMicrochip: false, isSterilized: false },
      null,
    );
    expect(out.has("con_chip")).toBe(false);
    expect(out.has("castrado")).toBe(false);
    expect(out.get("species")).toBe("dog");
  });

  it("omits criticality when set to a non-critical value", () => {
    const out = buildSearchParams({ criticality: "recent" } as LostListingFilters, null);
    expect(out.has("criticidad")).toBe(false);
  });
});

describe("lib/lost-listing — lostUrgencyFor", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  it("treats null as 'older'", () => {
    expect(lostUrgencyFor(null, now)).toBe("older");
  });

  it("returns 'critical' for events in the last 24h", () => {
    expect(lostUrgencyFor(new Date(now.getTime() - 60 * 60 * 1000), now)).toBe("critical");
    expect(lostUrgencyFor(new Date(now.getTime() - 23 * 60 * 60 * 1000), now)).toBe("critical");
  });

  it("returns 'recent' for events between 24h and 7d", () => {
    expect(lostUrgencyFor(new Date(now.getTime() - 25 * 60 * 60 * 1000), now)).toBe("recent");
    expect(lostUrgencyFor(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000), now)).toBe("recent");
  });

  it("returns 'older' for events more than 7d ago", () => {
    expect(lostUrgencyFor(new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), now)).toBe("older");
  });
});

describe("lib/lost-listing — lostTimeLabel", () => {
  const now = new Date("2026-05-26T12:00:00.000Z");

  it("treats null as em-dash", () => {
    expect(lostTimeLabel(null, now)).toBe("—");
  });

  it("renders the minute window (lowercase; card CSS uppercases)", () => {
    expect(lostTimeLabel(new Date(now.getTime() - 30 * 1000), now)).toBe("recién");
    expect(lostTimeLabel(new Date(now.getTime() - 12 * 60 * 1000), now)).toBe("hace 12 min");
  });

  it("renders the hour window", () => {
    expect(lostTimeLabel(new Date(now.getTime() - 5 * 60 * 60 * 1000), now)).toBe("hace 5 h");
    expect(lostTimeLabel(new Date(now.getTime() - 23 * 60 * 60 * 1000), now)).toBe("hace 23 h");
  });

  it("uses DAY granularity below one month — no weeks, so never 'hace 0 meses'", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    expect(lostTimeLabel(new Date(now.getTime() - dayMs), now)).toBe("hace 1 día");
    expect(lostTimeLabel(new Date(now.getTime() - 3 * dayMs), now)).toBe("hace 3 días");
    // Where the old week-bucketing said "Hace 1 semana" / "Hace 3 semanas":
    expect(lostTimeLabel(new Date(now.getTime() - 7 * dayMs), now)).toBe("hace 7 días");
    expect(lostTimeLabel(new Date(now.getTime() - 21 * dayMs), now)).toBe("hace 21 días");
    // The exact regression: 28 days used to render "Hace 0 meses".
    expect(lostTimeLabel(new Date(now.getTime() - 28 * dayMs), now)).toBe("hace 28 días");
  });

  it("renders month/year ranges with proper singular/plural", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    expect(lostTimeLabel(new Date(now.getTime() - 30 * dayMs), now)).toBe("hace 1 mes");
    expect(lostTimeLabel(new Date(now.getTime() - 35 * dayMs), now)).toBe("hace 1 mes");
    expect(lostTimeLabel(new Date(now.getTime() - 120 * dayMs), now)).toBe("hace 4 meses");
    expect(lostTimeLabel(new Date(now.getTime() - 400 * dayMs), now)).toBe("hace 1 año");
    expect(lostTimeLabel(new Date(now.getTime() - 800 * dayMs), now)).toBe("hace 2 años");
  });
});
