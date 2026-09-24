// The client-input contract for org intake (native-readiness T1.3).
//
// These assertions are the contract's half of the boundary: what a client may
// send, what it may omit, and what it may get wrong without being rejected.
// The app's half — breed catalogue, INDEC canonicalization, date plausibility,
// chip cross-check — is tested where it lives, against a database.
//
// Several cases below look permissive on purpose. An intake form is filled in
// at a kennel door with an animal in somebody's arms; rejecting the whole
// submission because the age estimate reads oddly would lose the record, and a
// lost record is worse than an imprecise one.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CREATE_INTAKE_INPUT_CODES,
  createIntakeInputSchema,
  firstIntakeInputCode,
} from "../intake.ts";

const MINIMAL = { name: "Sin nombre", species: "dog", intakeReason: "rescue" };

describe("createIntakeInputSchema — the required three", () => {
  it("accepts the minimum a client can send", () => {
    const result = createIntakeInputSchema.safeParse(MINIMAL);
    expect(result.success).toBe(true);
  });

  it("rejects a blank name with NAME_REQUIRED", () => {
    const result = createIntakeInputSchema.safeParse({ ...MINIMAL, name: "   " });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIntakeInputCode(result.error)).toBe("NAME_REQUIRED");
  });

  it("rejects a missing species with SPECIES_REQUIRED", () => {
    const result = createIntakeInputSchema.safeParse({ name: "Pampa", intakeReason: "rescue" });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIntakeInputCode(result.error)).toBe("SPECIES_REQUIRED");
  });

  it("rejects an unknown intake reason with INTAKE_REASON_REQUIRED", () => {
    // "seizure" is a real DB enum value and deliberately NOT a client value: a
    // decomiso is a State act and goes through the government flow.
    const result = createIntakeInputSchema.safeParse({ ...MINIMAL, intakeReason: "seizure" });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIntakeInputCode(result.error)).toBe("INTAKE_REASON_REQUIRED");
  });
});

describe("firstIntakeInputCode — one message, deterministically chosen", () => {
  it("reports the first code in contract order, not in zod's issue order", () => {
    // Everything is wrong at once. The wizard shows ONE message, and which one
    // must not depend on how zod happened to walk the object.
    const result = createIntakeInputSchema.safeParse({ name: "", species: "", intakeReason: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIntakeInputCode(result.error)).toBe("NAME_REQUIRED");
  });

  it("reports the field's own code even when the value is the wrong TYPE", () => {
    // A non-string name is a client bug rather than something the operator
    // mistyped, but the field is still the answer to "what is wrong", so the
    // code carries. The alternative — a generic message — would tell the
    // person at the kennel door nothing at all.
    const result = createIntakeInputSchema.safeParse({ ...MINIMAL, name: 42 });
    expect(result.success).toBe(false);
    if (!result.success) expect(firstIntakeInputCode(result.error)).toBe("NAME_REQUIRED");
  });

  it("returns null for an error carrying no code this contract defines", () => {
    // The consumer's cue to show a generic message rather than a raw zod
    // string. Exercised through a foreign schema because every failure the
    // intake schema itself can produce is coded — which is the point.
    const foreign = z.object({ whatever: z.string() }).safeParse({});
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(firstIntakeInputCode(foreign.error)).toBeNull();
  });

  it("declares its codes in the order it reports them", () => {
    expect([...CREATE_INTAKE_INPUT_CODES]).toEqual([
      "NAME_REQUIRED",
      "SPECIES_REQUIRED",
      "INTAKE_REASON_REQUIRED",
    ]);
  });
});

describe("enums that fall back instead of failing", () => {
  it("defaults an absent sex to unknown", () => {
    const result = createIntakeInputSchema.parse(MINIMAL);
    expect(result.sex).toBe("unknown");
  });

  it("folds an unrecognised sex to unknown rather than rejecting the intake", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, sex: "macho" }).sex).toBe("unknown");
  });

  it("keeps a recognised sex", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, sex: "female" }).sex).toBe("female");
  });

  it("defaults custodyRole to shelter_custody — the rescue-and-rehome path", () => {
    expect(createIntakeInputSchema.parse(MINIMAL).custodyRole).toBe("shelter_custody");
    expect(createIntakeInputSchema.parse({ ...MINIMAL, custodyRole: "nonsense" }).custodyRole).toBe(
      "shelter_custody",
    );
  });

  it("keeps owner custody when the org says so", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, custodyRole: "owner" }).custodyRole).toBe(
      "owner",
    );
  });
});

describe("optional text — blank and absent mean the same thing", () => {
  it("nulls an absent optional field", () => {
    const parsed = createIntakeInputSchema.parse(MINIMAL);
    expect(parsed.microchipId).toBeNull();
    expect(parsed.color).toBeNull();
    expect(parsed.occurredAt).toBeNull();
  });

  it("nulls a whitespace-only optional field", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, color: "   " }).color).toBeNull();
  });

  it("trims what it keeps", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, color: "  negro " }).color).toBe("negro");
  });
});

describe("age estimates", () => {
  it("nulls absent ages", () => {
    const parsed = createIntakeInputSchema.parse(MINIMAL);
    expect(parsed.ageYears).toBeNull();
    expect(parsed.ageMonths).toBeNull();
  });

  it("parses a plain count", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, ageYears: "3" }).ageYears).toBe(3);
  });

  it("clamps a negative to zero", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, ageMonths: "-6" }).ageMonths).toBe(0);
  });

  it("reads a leading number out of a hand-typed estimate", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, ageYears: "2 aprox" }).ageYears).toBe(2);
  });

  it("falls back to zero rather than losing the intake over an unparseable age", () => {
    expect(createIntakeInputSchema.parse({ ...MINIMAL, ageYears: "cachorro" }).ageYears).toBe(0);
  });
});

describe("unknown fields", () => {
  it("drops what the contract does not describe", () => {
    // A client cannot smuggle a column in through the input boundary.
    const parsed = createIntakeInputSchema.parse({ ...MINIMAL, ownerUserId: "attacker" });
    expect(parsed).not.toHaveProperty("ownerUserId");
  });
});

describe("padded values", () => {
  // A form encoding or a CSV mapper can pad. Two clients sending the same
  // intent must not get different answers because one of them left a space.
  it("accepts a padded intake reason", () => {
    expect(
      createIntakeInputSchema.parse({ ...MINIMAL, intakeReason: " rescue " }).intakeReason,
    ).toBe("rescue");
  });

  it("accepts a padded sex and custody role", () => {
    const parsed = createIntakeInputSchema.parse({
      ...MINIMAL,
      sex: " female ",
      custodyRole: " owner ",
    });
    expect(parsed.sex).toBe("female");
    expect(parsed.custodyRole).toBe("owner");
  });

  it("accepts a padded name and species", () => {
    const parsed = createIntakeInputSchema.parse({
      name: "  Pampa  ",
      species: " dog ",
      intakeReason: "rescue",
    });
    expect(parsed.name).toBe("Pampa");
    expect(parsed.species).toBe("dog");
  });
});
