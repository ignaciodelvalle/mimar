// Unit + mutation-proof tests for scripts/check-event-payload-privacy.ts
// (T3-A2b). Replaces check-event-string-sweep.test.ts.
//
// Pure: synthetic zod schemas and synthetic tables, plus the REAL table
// against the REAL schemas (no disk beyond imports, no DB). The mutation
// proofs re-create the bugs this fence exists to catch — an unclassified leaf,
// and the enum `reason` a key-name sweep destroyed — and assert red, then
// green once fixed.

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { petEvents } from "@/db/schema";
import { PayloadSchemas } from "@/lib/events/event-schemas";
import {
  PAYLOAD_PRIVACY,
  PET_EVENT_COLUMN_PRIVACY,
  PROFILE_CHANGE_FIELD_PRIVACY,
  type PrivacyEntry,
  authorKept,
  isMachineCode,
  pathToKeyPath,
  redactionRules,
} from "@/lib/events/payload-privacy";

import {
  MIN_EXPECTED_LEAVES,
  checkColumnPrivacy,
  checkDeclaredCodes,
  checkGatedParty,
  checkKindAndLegacy,
  checkPayloadPrivacy,
  checkProfileChangeFields,
  checkWriterCodes,
  extractChangeFields,
  extractWriterLiterals,
  schemaNodes,
} from "./check-event-payload-privacy";

const CF: PrivacyEntry = { class: "compliance_fact" };
const WHY = "A written reason long enough to count.";

function run(
  schemas: Record<string, z.ZodTypeAny>,
  table: Record<string, Record<string, PrivacyEntry>>,
) {
  return checkPayloadPrivacy(schemas, table, 0).violations.map((v) => v.kind);
}

describe("schemaNodes — the walker", () => {
  it("walks nested objects, arrays of objects and z.unknown()", () => {
    const nodes = schemaNodes(
      z.object({
        a: z.string(),
        nested: z.object({ b: z.number().nullable() }).optional(),
        changes: z.array(z.object({ field: z.string(), old: z.unknown() })),
        tags: z.array(z.string()).optional(),
      }),
    );
    const leaves = [...nodes].filter(([, n]) => n.leaf).map(([p]) => p);
    expect(leaves.sort()).toEqual(["a", "changes[].field", "changes[].old", "nested.b", "tags"]);
    expect(nodes.get("nested.b")?.nullable).toBe(true);
    expect(nodes.get("nested")?.optional).toBe(true);
    expect(nodes.get("changes[].old")?.kinds.has("any")).toBe(true);
    expect(nodes.get("tags")?.kinds.has("array")).toBe(true);
  });

  it("merges the variants of a discriminated union, optional unless some variant requires the key", () => {
    const nodes = schemaNodes(
      z.discriminatedUnion("sub_kind", [
        z.object({ sub_kind: z.literal("x"), reason: z.string() }),
        z.object({ sub_kind: z.literal("y"), purpose: z.string().optional() }),
      ]),
    );
    expect(nodes.get("sub_kind")?.kinds.has("literal")).toBe(true);
    expect(nodes.get("reason")?.optional).toBe(false);
    expect(nodes.get("purpose")?.optional).toBe(true);
  });

  it("sees through a .refine() and a plain union", () => {
    const nodes = schemaNodes(
      z
        .object({ v: z.union([z.string(), z.number()]), e: z.enum(["a", "b"]) })
        .refine((o) => o.e !== "b"),
    );
    expect([...(nodes.get("v")?.kinds ?? [])].sort()).toEqual(["number", "string"]);
    expect(nodes.get("e")?.kinds.has("enum")).toBe(true);
  });
});

describe("checkPayloadPrivacy — violations", () => {
  const schemas = { t: z.object({ note: z.string(), code: z.enum(["a", "b"]) }) };

  it("an unclassified leaf is red", () => {
    expect(run(schemas, { t: { code: CF } })).toContain("unclassified");
  });

  it("a stale path is red", () => {
    expect(run(schemas, { t: { note: CF, code: CF, gone: CF } })).toContain("stale");
  });

  it("a path classified twice (self and ancestor) is red", () => {
    const s = { t: z.object({ o: z.object({ k: z.string() }) }) };
    expect(run(s, { t: { o: CF, "o.k": CF } })).toContain("double-classified");
  });

  it("a sentinel on an ENUM leaf is red — the `reason` bug", () => {
    const table = {
      t: {
        note: CF,
        code: { class: "personal_data", transform: "sentinel", why: WHY } as PrivacyEntry,
      },
    };
    expect(run(schemas, table)).toContain("transform-misfit");
  });

  it("a sentinel on an `_id` key or a uuid leaf is red", () => {
    const s = { t: z.object({ owner_id: z.string(), ref: z.string().uuid() }) };
    const sentinel: PrivacyEntry = { class: "personal_data", transform: "sentinel", why: WHY };
    expect(run(s, { t: { owner_id: sentinel, ref: CF } })).toContain("transform-misfit");
    expect(run(s, { t: { owner_id: CF, ref: sentinel } })).toContain("transform-misfit");
  });

  it("drop on a required key and null on a non-nullable key are red", () => {
    const s = { t: z.object({ a: z.string(), b: z.string() }) };
    expect(
      run(s, { t: { a: { class: "personal_data", transform: "drop", why: WHY }, b: CF } }),
    ).toContain("transform-misfit");
    expect(
      run(s, { t: { a: CF, b: { class: "personal_data", transform: "null", why: WHY } } }),
    ).toContain("transform-misfit");
  });

  it("a personal_data or professional_act entry without a written reason is red", () => {
    expect(
      run(schemas, {
        t: { note: { class: "professional_act", why: "short" }, code: CF },
      }),
    ).toContain("missing-reason");
  });

  it("a party key that is not a uuid key of the payload is red", () => {
    const s = { t: z.object({ note: z.string(), who: z.string() }) };
    const table = {
      t: {
        note: { class: "personal_data", transform: "sentinel", why: WHY, partyKeys: ["who"] },
        who: CF,
      } as Record<string, PrivacyEntry>,
    };
    expect(run(s, table)).toContain("bad-party-key");
  });

  it("the floor goes red when the walk finds too few leaves", () => {
    const { violations } = checkPayloadPrivacy(
      { t: z.object({ a: z.string() }) },
      { t: { a: CF } },
    );
    expect(violations.map((v) => v.kind)).toContain("floor");
  });
});

describe("mutation proof — the live bug", () => {
  it("sentinelling microchip_replaced.reason (an enum) is caught, and the real entry is clean", () => {
    const schemas = { microchip_replaced: PayloadSchemas.microchip_replaced as z.ZodTypeAny };
    const real = PAYLOAD_PRIVACY.microchip_replaced;
    expect(checkPayloadPrivacy(schemas, { microchip_replaced: real }, 0).violations).toEqual([]);

    const mutant = {
      ...real,
      reason: { class: "personal_data", transform: "sentinel", why: WHY } as PrivacyEntry,
    };
    const kinds = run(schemas, { microchip_replaced: mutant });
    expect(kinds).toContain("transform-misfit");
  });

  it("the same holds for every other enum `reason` the 0228 sweep destroyed", () => {
    for (const t of ["foster_ended", "custody_transferred", "custody_transfer_proposed"] as const) {
      const schemas = { [t]: PayloadSchemas[t] as z.ZodTypeAny };
      const mutant = {
        ...PAYLOAD_PRIVACY[t],
        reason: { class: "personal_data", transform: "sentinel", why: WHY } as PrivacyEntry,
      };
      expect(run(schemas, { [t]: mutant }), t).toContain("transform-misfit");
    }
  });

  it("removing one real entry leaves its leaf unclassified", () => {
    const { free_text: _removed, ...rest } = PAYLOAD_PRIVACY.symptom_observed;
    const schemas = { symptom_observed: PayloadSchemas.symptom_observed as z.ZodTypeAny };
    expect(run(schemas, { symptom_observed: rest })).toContain("unclassified");
  });
});

describe("the real tables", () => {
  it("classify every leaf of every payload schema with zero violations, above the floor", () => {
    const { violations, leafCount } = checkPayloadPrivacy(
      PayloadSchemas as Record<string, z.ZodTypeAny>,
      PAYLOAD_PRIVACY,
    );
    expect(violations).toEqual([]);
    expect(leafCount).toBeGreaterThanOrEqual(MIN_EXPECTED_LEAVES);
  });

  it("classify every pet_events column", () => {
    const columns = Object.values(getTableColumns(petEvents)).map((c) => ({
      name: c.name,
      dataType: c.dataType,
    }));
    expect(checkColumnPrivacy(columns, PET_EVENT_COLUMN_PRIVACY)).toEqual([]);
    expect(
      checkColumnPrivacy(
        [...columns, { name: "new_col", dataType: "string" }],
        PET_EVENT_COLUMN_PRIVACY,
      ).map((v) => v.kind),
    ).toContain("unclassified-column");
  });

  it("changelog fields: extraction, unclassified and stale", () => {
    expect(
      extractChangeFields(`{ field: "name", old: 1 }, { field: "insurance_company" }`),
    ).toEqual(["name", "insurance_company"]);
    const emitted = new Set(Object.keys(PROFILE_CHANGE_FIELD_PRIVACY));
    expect(checkProfileChangeFields(emitted, PROFILE_CHANGE_FIELD_PRIVACY)).toEqual([]);
    expect(
      checkProfileChangeFields(
        new Set([...emitted, "new_field"]),
        PROFILE_CHANGE_FIELD_PRIVACY,
      ).map((v) => v.kind),
    ).toContain("unclassified-change-field");
  });

  it("redactionRules() never targets an enum reason nor an `_id` key", () => {
    const rules = redactionRules();
    expect(rules.length).toBeGreaterThan(40);
    const enumReason = new Set([
      "microchip_replaced",
      "foster_ended",
      "custody_transferred",
      "custody_transfer_proposed",
    ]);
    for (const r of rules) {
      expect(enumReason.has(r.event_type) && r.key_path.join(".") === "reason", r.event_type).toBe(
        false,
      );
      expect(/_id$/.test(r.key_path[r.key_path.length - 1] ?? ""), r.key_path.join(".")).toBe(
        false,
      );
    }
  });

  it("pathToKeyPath splits object keys and array steps", () => {
    expect(pathToKeyPath("changes[].old")).toEqual(["changes", "[]", "old"]);
    expect(pathToKeyPath("lost_description.behavior_notes")).toEqual([
      "lost_description",
      "behavior_notes",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Security review of T3-A2b — items 1, 2, 3, 5 and 7.
// ---------------------------------------------------------------------------

describe("item 2 — an author gate with party keys must say why", () => {
  it("is red without a reason and clean with one", () => {
    const e: PrivacyEntry = {
      class: "professional_act",
      why: WHY,
      authorGated: { otherwise: "sentinel" },
      partyKeys: ["adopter_user_id"],
    };
    expect(checkGatedParty("t.reason", e).map((v) => v.kind)).toEqual(["gated-party"]);
    expect(
      checkGatedParty("t.reason", {
        ...e,
        gatedPartyReason: "Intended: only an author may erase.",
      }),
    ).toEqual([]);
  });

  it("the real tables carry no undocumented combination (adoption_reversed.reason included)", () => {
    for (const [t, keys] of Object.entries(PAYLOAD_PRIVACY)) {
      for (const [k, e] of Object.entries(keys)) {
        expect(checkGatedParty(`${t}.${k}`, e), `${t}.${k}`).toEqual([]);
      }
    }
    expect(PAYLOAD_PRIVACY.adoption_reversed.reason?.class).toBe("personal_data");
  });
});

describe("item 1 — machine codes under prose keys", () => {
  const SRC = `
    const payload = validateEventPayload("status_changed", {
      from_status: "lost",
      to_status: "active",
      reason: "return_to_original_owner",
    });
    const other = validateEventPayload("adoption_application_resolved", {
      reason: args.outcome === "rejected" ? (args.reason ?? "manual_rejection") : undefined,
    });
  `;

  it("finds code-like literals written under keys, not the ones only compared against", () => {
    const lits = extractWriterLiterals("w.ts", SRC).map(
      (l) => `${l.eventType}.${l.key}=${l.value}`,
    );
    expect(lits).toContain("status_changed.reason=return_to_original_owner");
    expect(lits).toContain("adoption_application_resolved.reason=manual_rejection");
    expect(lits).not.toContain("adoption_application_resolved.reason=rejected");
  });

  it("MUTANT: an undeclared code under a sentinel key is red; declared, it is clean", () => {
    const lits = extractWriterLiterals("w.ts", SRC);
    const noCodes = (): PrivacyEntry => ({
      class: "personal_data",
      transform: "sentinel",
      why: WHY,
    });
    expect(checkWriterCodes(lits, SRC, noCodes, []).map((v) => v.kind)).toContain(
      "undeclared-code",
    );
    const declared = (_t: string, key: string): PrivacyEntry | undefined =>
      key === "reason"
        ? {
            class: "personal_data",
            transform: "sentinel",
            why: WHY,
            codes: ["return_to_original_owner", "manual_rejection"],
          }
        : undefined;
    expect(checkWriterCodes(lits, SRC, declared, [])).toEqual([]);
  });

  it("a declared code no source writes is stale; a declared code that is not code-shaped is red", () => {
    expect(
      checkWriterCodes([], SRC, () => undefined, [{ at: "t.reason", code: "gone_code" }]).map(
        (v) => v.kind,
      ),
    ).toEqual(["stale-code"]);
    const e: PrivacyEntry = {
      class: "personal_data",
      transform: "sentinel",
      why: WHY,
      codes: ["juan"],
    };
    expect(checkDeclaredCodes("t.reason", e).map((v) => v.kind)).toEqual(["code-not-code-shaped"]);
  });

  it("the code shape keeps codes and never a name, a phone or prose", () => {
    expect(isMachineCode("return_to_original_owner")).toBe(true);
    expect(isMachineCode("volunteer_withdrew")).toBe(true);
    expect(isMachineCode("juan")).toBe(false);
    expect(isMachineCode("juan_1155551234")).toBe(false);
    expect(isMachineCode("Se escapó por el portón")).toBe(false);
  });

  it("the real writers' codes are declared: status_changed.reason keeps return_to_original_owner", () => {
    const e = PAYLOAD_PRIVACY.status_changed.reason;
    expect(e?.class === "personal_data" ? e.codes : []).toContain("return_to_original_owner");
  });
});

describe("items 3 and 7 — per-kind and legacy keys", () => {
  it("the real kind and legacy tables are clean", () => {
    expect(checkKindAndLegacy(PayloadSchemas as Record<string, z.ZodTypeAny>)).toEqual([]);
  });

  it("a kind path the schema lacks, and a legacy key the schema now declares, are red", () => {
    const kinds = { note_added: { adoption_info_requested: { nope: CF } } };
    const legacy = {
      note_added: {
        text: { class: "personal_data", transform: "sentinel", why: WHY } as PrivacyEntry,
      },
    };
    const schemas = PayloadSchemas as Record<string, z.ZodTypeAny>;
    expect(checkKindAndLegacy(schemas, kinds as never, {}).map((v) => v.kind)).toEqual([
      "stale-kind-path",
    ]);
    expect(checkKindAndLegacy(schemas, {}, legacy as never).map((v) => v.kind)).toEqual([
      "legacy-now-declared",
    ]);
  });

  it("the info request has its own key, reached through the applicant", () => {
    const e = PAYLOAD_PRIVACY.note_added.info_request_message;
    expect(e?.class === "personal_data" ? e.partyKeys : []).toEqual([
      "application_event_id>applicant_user_id",
    ]);
    expect(
      redactionRules().some((r) => r.event_type === "note_added:adoption_info_requested"),
    ).toBe(true);
  });
});

describe("item 5 — the PO default on the author gate", () => {
  it("an unverified shelter is not a kept author; vet / govt / system need no verification", () => {
    expect(authorKept("shelter", false)).toBe(false);
    expect(authorKept("shelter", true)).toBe(true);
    expect(authorKept("vet", false)).toBe(true);
    expect(authorKept("owner", true)).toBe(false);
  });
});
