/**
 * Unit tests for scripts/check-event-payload-parity.ts.
 *
 * Pure fixture tests — no filesystem I/O beyond the real schemas file for the
 * end-to-end sanity check at the bottom. Each rule documented in the script's
 * header comment gets a fixture proving precision (no false positives on the
 * documented exclusion classes) and recall (the real ghost-payload class is
 * still caught).
 */

import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EXCLUDED_PAYLOAD_BASE_IDENTIFIERS,
  extractReadHits,
  extractWrittenKeys,
  scanObjectLiteral,
  stripComments,
} from "@/scripts/check-event-payload-parity";

// ---------------------------------------------------------------------------
// stripComments
// ---------------------------------------------------------------------------

describe("stripComments", () => {
  it("blanks out a line comment but keeps the line count stable", () => {
    const src = "const a = 1;\n// payload->>'key' is just an example\nconst b = 2;";
    const stripped = stripComments(src);
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripped).not.toContain("payload->>'key'");
  });

  it("blanks out a block comment across multiple lines, keeping newlines", () => {
    const src = "const a = 1;\n/* payload->>'ghost'\n   still in the comment */\nconst b = 2;";
    const stripped = stripComments(src);
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toContain("ghost");
  });

  it("does not touch a real string literal", () => {
    const src = "const s = \"payload->>'kind'\";";
    expect(stripComments(src)).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// scanObjectLiteral — depth-1 key extraction
// ---------------------------------------------------------------------------

describe("scanObjectLiteral", () => {
  it("extracts only depth-1 keys, skipping nested object keys", () => {
    const src = "{ name: z.string(), changes: z.array(z.object({ field: z.string(), old: 1 })) }";
    const scan = scanObjectLiteral(src, src.indexOf("{"));
    expect(scan.keys).toEqual(["name", "changes"]);
    expect(scan.keys).not.toContain("field");
    expect(scan.keys).not.toContain("old");
  });

  it("captures a spread identifier separately from plain keys", () => {
    const src = "{ ...welfareCore, severity: z.enum([]), kind: z.enum([]) }";
    const scan = scanObjectLiteral(src, src.indexOf("{"));
    expect(scan.spreads).toEqual(["welfareCore"]);
    expect(scan.keys).toEqual(["severity", "kind"]);
  });

  it("handles a quoted string key", () => {
    const src = '{ "weird-key": z.string(), plain: z.string() }';
    const scan = scanObjectLiteral(src, src.indexOf("{"));
    expect(scan.keys).toEqual(["weird-key", "plain"]);
  });
});

// ---------------------------------------------------------------------------
// extractWrittenKeys — schema shapes found in lib/events/event-schemas.ts
// ---------------------------------------------------------------------------

describe("extractWrittenKeys", () => {
  it("extracts keys from `z.object(withVersion({...})).strict()` split across lines", () => {
    const src = `
const withVersion = (shape) => ({ payload_version: z.literal(1).default(1), ...shape });
const petRegistered = z
  .object(
    withVersion({
      name: z.string(),
      species: z.string(),
    }),
  )
  .strict();
`;
    const keys = extractWrittenKeys(src);
    expect(keys.has("name")).toBe(true);
    expect(keys.has("species")).toBe(true);
    expect(keys.has("payload_version")).toBe(true);
  });

  it("resolves a bare-identifier shape reference, e.g. z.object(withVersion(welfareCore))", () => {
    const src = `
const welfareCore = {
  welfare_report_id: z.string().uuid(),
  reporter_role: z.enum(["owner", "witness"]),
};
const abandonmentReported = z.object(withVersion(welfareCore)).strict();
`;
    const keys = extractWrittenKeys(src);
    expect(keys.has("welfare_report_id")).toBe(true);
    expect(keys.has("reporter_role")).toBe(true);
  });

  it("resolves an inline spread of a named shape plus its own extra keys", () => {
    const src = `
const welfareCore = {
  welfare_report_id: z.string().uuid(),
  reporter_role: z.enum(["owner", "witness"]),
};
const maltreatmentReported = z
  .object(
    withVersion({
      ...welfareCore,
      severity: z.enum(["low", "high"]),
    }),
  )
  .strict();
`;
    const keys = extractWrittenKeys(src);
    expect(keys.has("welfare_report_id")).toBe(true);
    expect(keys.has("severity")).toBe(true);
  });

  it("unions keys across every z.object( call, independent of discriminatedUnion/union wrapping", () => {
    const src = `
const a = z.object(withVersion({ sub_kind: z.literal("a"), foo: z.string() })).strict();
const b = z.object(withVersion({ sub_kind: z.literal("b"), bar: z.string() })).strict();
const combined = z.discriminatedUnion("sub_kind", [a, b]);
`;
    const keys = extractWrittenKeys(src);
    expect(keys.has("foo")).toBe(true);
    expect(keys.has("bar")).toBe(true);
  });

  it("ignores illustrative key names inside comments", () => {
    const src = `
// example: payload->>'not_a_real_key'
const petRegistered = z.object(withVersion({ name: z.string() })).strict();
`;
    const keys = extractWrittenKeys(src);
    expect(keys.has("not_a_real_key")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractReadHits — SQL variants
// ---------------------------------------------------------------------------

describe("extractReadHits — SQL payload->>'key' variants", () => {
  it("matches the drizzle interpolated form for petEvents", () => {
    const src = "sql`${petEvents.payload}->>'kind' = 'sighting'`;";
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).toContain("kind");
  });

  it("does NOT match the interpolated form for a different table's payload column", () => {
    // Regression: lib/analytics/program-health.ts reads
    // `${auditLog.payload}->>'surface'` — a DIFFERENT jsonb column
    // (audit_log.payload), not pet_events.payload.
    const src = "sql`${auditLog.payload}->>'surface'`;";
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).not.toContain("surface");
  });

  it("matches an aliased raw-SQL form", () => {
    const src = "AND ended.payload->>'observation_started_event_id' = started.id";
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).toContain("observation_started_event_id");
  });

  it("matches an unqualified bare-column form", () => {
    const src = "AND payload->>'application_event_id' = ${id}";
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).toContain("application_event_id");
  });

  it("does not choke on a dynamic (non-literal) field interpolation", () => {
    const src = "sql`${payloadRef}->>${field}`;";
    expect(() => extractReadHits("lib/example.ts", src)).not.toThrow();
    expect(extractReadHits("lib/example.ts", src)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractReadHits — JS accessor variants
// ---------------------------------------------------------------------------

describe("extractReadHits — JS .payload accessor variants", () => {
  it("matches base.payload.key when the file references petEvents", () => {
    // Regression: an earlier version of the combined regex could never match
    // `base.payload.key` at all (the base-capture and the bare-form
    // lookbehind were self-contradictory) — this is the exact shape from
    // src/modules/lost/infrastructure/lost-listing-read.ts that exposed it.
    const src = `
      import { petEvents } from "@/db";
      const rawDescription = meta.payload.location_description;
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).toContain("location_description");
  });

  it("matches base.payload?.key and base.payload['key']", () => {
    const src = `
      import { petEvents } from "@/db";
      const a = e.payload?.drug_name;
      const b = e.payload['drug_name'];
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.filter((h) => h.key === "drug_name")).toHaveLength(2);
  });

  it("matches a bare `payload.key` local (no base identifier)", () => {
    const src = `
      import { petEvents } from "@/db";
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const kg = payload.kg;
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).toContain("kg");
  });

  it("does NOT match .payload.key when the file never references petEvents", () => {
    // Bounds noise per the task brief — a file with no petEvents reference
    // at all is assumed to not be reading event payloads.
    const src = "const x = someOtherThing.payload.someKey;";
    expect(extractReadHits("lib/example.ts", src)).toEqual([]);
  });

  it("excludes a resolveBusinessRule-bound identifier ending in Rule", () => {
    // Regression: lib/analytics/org-dashboard.ts and surveillance-metrics.ts
    // both import petEvents AND call resolveBusinessRule(), whose return
    // value also has a `.payload` — a DIFFERENT jsonb column
    // (business_rules.payload). Every call site in the repo binds it to a
    // *Rule identifier.
    const src = `
      import { petEvents } from "@/db";
      const longStayRule = await resolveBusinessRule("long_stay_days", jurisdiction);
      const days = longStayRule.payload.days;
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).not.toContain("days");
  });

  it("excludes identifiers in the explicit denylist", () => {
    // Regression: src/modules/organizations/application/admin-decisions
    // reads an approvalRequests row's OWN `.payload` (a different jsonb
    // column) via a `request` local. Direct `base.payload.key` access is
    // excluded by the denylist; see the script header for the residual
    // limitation on the bare `payload.key` shape.
    expect(EXCLUDED_PAYLOAD_BASE_IDENTIFIERS.has("request")).toBe(true);
    const src = `
      import { petEvents } from "@/db";
      const petId = request.payload.pet_id;
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).not.toContain("pet_id");
  });

  it("ignores an illustrative key name inside a comment", () => {
    const src = `
      import { petEvents } from "@/db";
      // e.payload.not_a_real_key is just an example in this comment
      const x = 1;
    `;
    const hits = extractReadHits("lib/example.ts", src);
    expect(hits.map((h) => h.key)).not.toContain("not_a_real_key");
  });
});

// ---------------------------------------------------------------------------
// End-to-end sanity check against the real schemas file
// ---------------------------------------------------------------------------

describe("extractWrittenKeys against the real schema family", () => {
  // THE SUBJECT IS THE FAMILY, NOT ONE FILE — and that is the same choice the
  // fence itself makes. check-event-payload-parity.ts globs
  // `lib/events/*event-schemas.ts` rather than naming files, with the comment
  // "glob the family instead of enumerating it: the next split is free".
  //
  // This test used to read `event-schemas.ts` alone. When the custody family
  // was split out to `custody-event-schemas.ts` (2026-08-21) it went red on
  // `transfer_token` and `seizure_motive` — correctly, because those keys had
  // moved, but for the wrong reason: nothing was broken, the test was just
  // looking at half the subject. Globbing the same set the fence globs means a
  // future split cannot make it fail, and — more importantly — cannot make it
  // silently stop covering a group either.
  const familyKeys = (): Set<string> => {
    const union = new Set<string>();
    for (const file of globSync("lib/events/*event-schemas.ts").sort()) {
      for (const k of extractWrittenKeys(readFileSync(file, "utf8"))) union.add(k);
    }
    return union;
  };

  it("finds more than one file in the family", () => {
    // NON-VACUITY. A broken glob would leave every assertion below reading an
    // empty set — the failure shape this repo keeps rediscovering in its fences.
    const files = globSync("lib/events/*event-schemas.ts");
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.map((f) => f.replaceAll("\\", "/"))).toContain(
      "lib/events/custody-event-schemas.ts",
    );
  });

  it("includes a representative key from nearly every schema group", () => {
    const keys = familyKeys();
    for (const expected of [
      "payload_version",
      "custody_kind", // pet_registered
      "location_description", // status_changed
      "vaccine_name", // vaccination_administered
      "target_event_id", // event_amended
      "transfer_token", // custody_transferred (P2P variant) — custody family
      "seizure_motive", // shelter_intake_recorded — custody family
      "grant_id", // caretaker_designated — caretaker family
    ]) {
      expect(keys.has(expected), `falta ${expected}`).toBe(true);
    }
  });
});
