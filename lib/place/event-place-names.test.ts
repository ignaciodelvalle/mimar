// The name pass's pure parts (PO decision 2026-10-06): reading the name out of
// an unresolved event_places row's `entered`, sorting what the resolver
// answered into unique / ambiguous / none, and the before/after projection.
// The fixtures are written by hand from the shapes the staging dry run found
// (2026-10-06): every unresolved row there was the spine backfill's
// {province, locality, source: "spine", spine_event_id}; the 0250 trigger's
// {province, locality, indec_id} is covered because the pass reads both.

import { describe, expect, it } from "vitest";

import {
  type ClassifiedPair,
  enteredShape,
  extractEnteredName,
  project,
  unaskable,
  verdictOf,
} from "./event-place-names";

import {
  describeHost,
  projectRef,
  targetProblem,
} from "@/scripts/place-resolve-event-places-by-name";

const spineQuilmes = {
  province: "Buenos Aires",
  locality: "Quilmes",
  source: "spine",
  spine_event_id: "9f0c2a7e-1111-4e2b-8c3d-000000000001",
};

describe("enteredShape", () => {
  it("tells the spine backfill's object from the trigger's, by keys", () => {
    expect(enteredShape(spineQuilmes)).toBe("spine");
    expect(enteredShape({ province: "Córdoba", locality: "Villa María", indec_id: null })).toBe(
      "event_place",
    );
    // `source: spine` without the spine event id is not the backfill's object.
    expect(enteredShape({ province: "Córdoba", locality: "Unquillo", source: "spine" })).toBe(
      "event_place",
    );
  });

  it("answers unknown for anything that is not a plain object with a place key", () => {
    expect(enteredShape({})).toBe("unknown");
    expect(enteredShape({ lat: -34.6, lng: -58.4 })).toBe("unknown");
    expect(enteredShape(null)).toBe("unknown");
    expect(enteredShape("Quilmes")).toBe("unknown");
    expect(enteredShape(["Buenos Aires", "Quilmes"])).toBe("unknown");
  });
});

describe("extractEnteredName", () => {
  it("spine shape: the row's province code wins, the locality comes trimmed", () => {
    expect(extractEnteredName({ ...spineQuilmes, locality: "  Quilmes " }, "AR-B")).toEqual({
      shape: "spine",
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: "Quilmes",
    });
  });

  it("spine shape with no row code: the entered province NAME gives it", () => {
    expect(
      extractEnteredName(
        { province: "Córdoba", locality: "Córdoba", source: "spine", spine_event_id: "x" },
        null,
      ),
    ).toEqual({
      shape: "spine",
      provinceCode: "AR-X",
      enteredProvince: "Córdoba",
      locality: "Córdoba",
    });
  });

  it("trigger shape: an entered ISO code is read as a code", () => {
    expect(
      extractEnteredName({ province: "AR-X", locality: "Villa María", indec_id: null }, null),
    ).toEqual({
      shape: "event_place",
      provinceCode: "AR-X",
      enteredProvince: "AR-X",
      locality: "Villa María",
    });
  });

  it("a registration that named no locality: locality null, province kept", () => {
    expect(
      extractEnteredName(
        { province: "Buenos Aires", locality: null, source: "spine", spine_event_id: "x" },
        "AR-B",
      ),
    ).toEqual({
      shape: "spine",
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: null,
    });
    expect(
      extractEnteredName(
        { province: null, locality: "   ", source: "spine", spine_event_id: "x" },
        null,
      ),
    ).toEqual({ shape: "spine", provinceCode: null, enteredProvince: null, locality: null });
  });

  it("a province no alias names: code null, the text kept for the report", () => {
    expect(
      extractEnteredName(
        {
          province: "Provincia Inventada",
          locality: "Tandil",
          source: "spine",
          spine_event_id: "x",
        },
        null,
      ),
    ).toEqual({
      shape: "spine",
      provinceCode: null,
      enteredProvince: "Provincia Inventada",
      locality: "Tandil",
    });
  });

  it("an unknown shape carries no name to ask about", () => {
    expect(extractEnteredName({ lat: 1, lng: 2 }, "AR-B")).toEqual({
      shape: "unknown",
      provinceCode: "AR-B",
      enteredProvince: null,
      locality: null,
    });
  });
});

describe("unaskable", () => {
  it("needs a locality and a real province code before asking the resolver", () => {
    expect(unaskable({ provinceCode: "AR-B", locality: "Quilmes" })).toBeNull();
    expect(unaskable({ provinceCode: "AR-B", locality: null })).toBe("no_locality");
    expect(unaskable({ provinceCode: null, locality: "Tandil" })).toBe("unknown_province");
    expect(unaskable({ provinceCode: "AR-Ñ", locality: "Tandil" })).toBe("unknown_province");
  });
});

describe("verdictOf", () => {
  it("unique only for a resolved answer that carries a row", () => {
    expect(
      verdictOf({ status: "resolved", localityId: "5d4c1b2a-0000-4000-8000-00000000abcd" }),
    ).toBe("unique");
    expect(verdictOf({ status: "resolved", localityId: null })).toBe("none");
  });

  it("a homonym is ambiguous, never unique", () => {
    // San Martín names several rows of Buenos Aires: the resolver says
    // ambiguous and returns no id.
    expect(verdictOf({ status: "ambiguous", localityId: null })).toBe("ambiguous");
  });

  it("a name the catalogue does not know is none", () => {
    expect(verdictOf({ status: "unresolved", localityId: null })).toBe("none");
  });
});

describe("project", () => {
  const pairs: ClassifiedPair[] = [
    {
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: "Quilmes",
      rows: 120,
      verdict: "unique",
      localityId: "5d4c1b2a-0000-4000-8000-00000000abcd",
      noneReason: null,
    },
    {
      provinceCode: "AR-X",
      enteredProvince: "Córdoba",
      locality: "Córdoba",
      rows: 30,
      verdict: "unique",
      localityId: "5d4c1b2a-0000-4000-8000-00000000abce",
      noneReason: null,
    },
    {
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: "Mechita",
      rows: 7,
      verdict: "ambiguous",
      localityId: null,
      noneReason: null,
    },
    {
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: null,
      rows: 5,
      verdict: "none",
      localityId: null,
      noneReason: "no_locality",
    },
    {
      provinceCode: null,
      enteredProvince: "Provincia Inventada",
      locality: "Tandil",
      rows: 2,
      verdict: "none",
      localityId: null,
      noneReason: "unknown_province",
    },
    {
      provinceCode: "AR-B",
      enteredProvince: "Buenos Aires",
      locality: "Villa Que No Existe",
      rows: 1,
      verdict: "none",
      localityId: null,
      noneReason: "not_in_catalogue",
    },
  ];

  it("moves only the unique rows from unresolved to resolved", () => {
    expect(project(pairs, { resolved: 10, unresolved: 165 })).toEqual({
      pairs: { unique: 2, ambiguous: 1, none: 3 },
      rows: { unique: 150, ambiguous: 7, none: 8 },
      noneRowsBy: { no_locality: 5, unknown_province: 2, not_in_catalogue: 1 },
      before: { resolved: 10, unresolved: 165 },
      after: { resolved: 160, unresolved: 15 },
    });
  });

  it("nothing to resolve: before equals after", () => {
    expect(project([], { resolved: 4, unresolved: 0 })).toEqual({
      pairs: { unique: 0, ambiguous: 0, none: 0 },
      rows: { unique: 0, ambiguous: 0, none: 0 },
      noneRowsBy: { no_locality: 0, unknown_province: 0, not_in_catalogue: 0 },
      before: { resolved: 4, unresolved: 0 },
      after: { resolved: 4, unresolved: 0 },
    });
  });
});

describe("the operator door's target guard", () => {
  // Fabricated, credential-free URLs in the shapes Supabase uses.
  const ref = "abcdefghijklmnopqrst";
  const otherRef = "zyxwvutsrqponmlkjihg";
  const pooler = `postgresql://postgres.${ref}:pw@aws-1-sa-east-1.pooler.supabase.com:6543/postgres`;
  const api = `https://${ref}.supabase.co`;
  const localDb = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const localApi = "http://127.0.0.1:54321";

  it("staging: both remote and the same project, or it refuses", () => {
    expect(targetProblem("staging", pooler, api)).toBeNull();
    expect(targetProblem("staging", pooler, localApi)).toMatch(/BOTH hosts remote/);
    expect(targetProblem("staging", localDb, api)).toMatch(/BOTH hosts remote/);
    expect(targetProblem("staging", pooler, `https://${otherRef}.supabase.co`)).toMatch(
      /DIFFERENT projects/,
    );
    expect(targetProblem("staging", pooler, undefined)).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(targetProblem("staging", undefined, api)).toMatch(/DATABASE_URL/);
  });

  it("local: both local, or it refuses", () => {
    expect(targetProblem("local", localDb, localApi)).toBeNull();
    expect(targetProblem("local", pooler, localApi)).toMatch(/BOTH hosts local/);
    expect(targetProblem("local", localDb, api)).toMatch(/BOTH hosts local/);
  });

  it("prints a host and a 6-character ref prefix, never the password or the full ref", () => {
    expect(projectRef(pooler)).toBe(ref);
    expect(projectRef(api)).toBe(ref);
    expect(describeHost(pooler)).toBe("aws-1-sa-east-1.pooler.supabase.com:6543 (ref abcdef…)");
    expect(describeHost(api)).toBe("abcdef….supabase.co (ref abcdef…)");
    expect(describeHost(pooler)).not.toContain("pw");
    expect(describeHost(localDb)).toBe("127.0.0.1:54322");
  });
});
