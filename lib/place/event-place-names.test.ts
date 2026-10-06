// The name pass's pure parts (PO decision 2026-10-06): reading the name out of
// an unresolved event_places row's `entered`, sorting what the resolver
// answered into unique / ambiguous / none, and the before/after projection.
// The fixtures are written by hand from the shapes the staging dry run found
// (2026-10-06): every unresolved row there was the spine backfill's
// {province, locality, source: "spine", spine_event_id}; the 0250 trigger's
// {province, locality, indec_id} is read too, but only counted: the pass
// never writes it.

import { describe, expect, it } from "vitest";

import {
  type ClassifiedPair,
  enteredShape,
  extractEnteredName,
  project,
  unaskable,
  verdictOf,
} from "./event-place-names";

import { STAGING_PROJECT_REF } from "@/scripts/_env-target";
import {
  describeHost,
  expectUniqueProblem,
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
  const base = {
    enteredProvince: "Buenos Aires",
    localityId: null,
    method: null,
    noneReason: null,
  };
  const pairs: ClassifiedPair[] = [
    {
      ...base,
      provinceCode: "AR-B",
      locality: "Quilmes",
      rows: 120,
      writableRows: 120,
      verdict: "unique",
      localityId: "5d4c1b2a-0000-4000-8000-00000000abcd",
      method: "exact_name_unique",
    },
    {
      // 30 rows, 4 of them projected by the 0250 trigger: those are held back.
      ...base,
      enteredProvince: "Córdoba",
      provinceCode: "AR-X",
      locality: "Cordoba",
      rows: 30,
      writableRows: 26,
      verdict: "unique",
      localityId: "5d4c1b2a-0000-4000-8000-00000000abce",
      method: "folded_name_unique",
    },
    {
      ...base,
      provinceCode: "AR-B",
      locality: "Mechita",
      rows: 7,
      writableRows: 7,
      verdict: "ambiguous",
    },
    {
      ...base,
      provinceCode: "AR-B",
      locality: null,
      rows: 5,
      writableRows: 5,
      verdict: "none",
      noneReason: "no_locality",
    },
    {
      ...base,
      enteredProvince: "Provincia Inventada",
      provinceCode: null,
      locality: "Tandil",
      rows: 2,
      writableRows: 2,
      verdict: "none",
      noneReason: "unknown_province",
    },
    {
      ...base,
      provinceCode: "AR-B",
      locality: "Villa Que No Existe",
      rows: 1,
      writableRows: 0,
      verdict: "none",
      noneReason: "not_in_catalogue",
    },
  ];

  it("moves only the spine-shaped unique rows, split by resolver method", () => {
    expect(project(pairs, { resolved: 10, unresolved: 165 })).toEqual({
      pairs: { unique: 2, ambiguous: 1, none: 3 },
      rows: { unique: 150, ambiguous: 7, none: 8 },
      noneRowsBy: { no_locality: 5, unknown_province: 2, not_in_catalogue: 1 },
      write: { rows: 146, exactRows: 120, foldedRows: 26 },
      heldUniqueRows: 4,
      before: { resolved: 10, unresolved: 165 },
      after: { resolved: 156, unresolved: 19 },
    });
  });

  it("nothing to resolve: before equals after", () => {
    expect(project([], { resolved: 4, unresolved: 0 })).toEqual({
      pairs: { unique: 0, ambiguous: 0, none: 0 },
      rows: { unique: 0, ambiguous: 0, none: 0 },
      noneRowsBy: { no_locality: 0, unknown_province: 0, not_in_catalogue: 0 },
      write: { rows: 0, exactRows: 0, foldedRows: 0 },
      heldUniqueRows: 0,
      before: { resolved: 4, unresolved: 0 },
      after: { resolved: 4, unresolved: 0 },
    });
  });
});

describe("the operator door's target guard", () => {
  // Credential-free URLs in the shapes Supabase uses. The staging ref is the
  // real one (public in this repo); the other is a made-up production-like ref
  // on the SAME pooler host, which is exactly the confusion the guard exists for.
  const ref = STAGING_PROJECT_REF;
  const otherRef = "zyxwvutsrqponmlkjihg";
  const pooler = (r: string) =>
    `postgresql://postgres.${r}:pw@aws-1-sa-east-1.pooler.supabase.com:6543/postgres`;
  const api = (r: string) => `https://${r}.supabase.co`;
  const localDb = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const localApi = "http://127.0.0.1:54321";

  it("staging: both remote, the same project, and that project is staging", () => {
    expect(targetProblem("staging", pooler(ref), api(ref))).toBeNull();
    expect(targetProblem("staging", pooler(ref), localApi)).toMatch(/BOTH hosts remote/);
    expect(targetProblem("staging", localDb, api(ref))).toMatch(/BOTH hosts remote/);
    expect(targetProblem("staging", pooler(ref), api(otherRef))).toMatch(/DIFFERENT projects/);
    expect(targetProblem("staging", pooler(ref), undefined)).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(targetProblem("staging", undefined, api(ref))).toMatch(/DATABASE_URL/);
  });

  it("refuses another project on the same pooler host, even when both URLs agree", () => {
    expect(targetProblem("staging", pooler(otherRef), api(otherRef))).toMatch(/NOT staging/);
  });

  it("local: both local, or it refuses", () => {
    expect(targetProblem("local", localDb, localApi)).toBeNull();
    expect(targetProblem("local", pooler(ref), localApi)).toMatch(/BOTH hosts local/);
    expect(targetProblem("local", localDb, api(ref))).toMatch(/BOTH hosts local/);
  });

  it("prints a host and a 6-character ref prefix, never the password or the full ref", () => {
    const short = `${ref.slice(0, 6)}…`;
    expect(projectRef(pooler(ref))).toBe(ref);
    expect(projectRef(api(ref))).toBe(ref);
    expect(describeHost(pooler(ref))).toBe(
      `aws-1-sa-east-1.pooler.supabase.com:6543 (ref ${short})`,
    );
    expect(describeHost(api(ref))).toBe(`${short}.supabase.co (ref ${short})`);
    expect(describeHost(pooler(ref))).not.toContain("pw");
    expect(describeHost(api(ref))).not.toContain(ref);
    expect(describeHost(localDb)).toBe("127.0.0.1:54322");
  });
});

describe("--apply needs the dry run's number", () => {
  it("refuses without --expect-unique, with a non-number, or with a different count", () => {
    expect(expectUniqueProblem(null, 10)).toMatch(/needs --expect-unique/);
    expect(expectUniqueProblem("ten", 10)).toMatch(/whole number/);
    expect(expectUniqueProblem("-1", 10)).toMatch(/whole number/);
    expect(expectUniqueProblem("9", 10)).toMatch(/finds 10 rows to write/);
  });

  it("accepts the exact count", () => {
    expect(expectUniqueProblem("10", 10)).toBeNull();
    expect(expectUniqueProblem("0", 0)).toBeNull();
  });
});
