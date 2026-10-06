// The pure half of `pnpm seed:situaciones` (scripts/seed-situaciones-plan.ts):
// the fixed QA tokens, the local-only guard, and the promise that every
// situation the owner page can derive is either seeded or explicitly answered
// for. The runner itself writes to a database and is not exercised here.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DIM_TOKEN_PATTERN } from "@/lib/domain/dim-token";
import { PET_SITUATIONS, type PetSituationKey } from "@/lib/ui/pet-situation";
import { findSeedMarker } from "@/scripts/hygiene-rules";
import {
  QA_PETS,
  QA_TOKEN_PREFIX,
  UNREACHABLE_RELATIONSHIPS,
  UNREACHABLE_SITUATIONS,
  formatSituacionesTable,
  reachedSituations,
  situacionesTargetProblem,
} from "@/scripts/seed-situaciones-plan";

// Derived from the product's own list, never hand-copied: a situation added to
// lib/ui/pet-situation.ts must fail this file until the plan answers for it.
const ALL_SITUATIONS = Object.keys(PET_SITUATIONS) as PetSituationKey[];

describe("seed:situaciones — tokens", () => {
  it("every QA pet has a unique, well-formed DIM-QSIT token", () => {
    const tokens = QA_PETS.map((p) => p.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(DIM_TOKEN_PATTERN);
      expect(token.startsWith(QA_TOKEN_PREFIX)).toBe(true);
    }
  });

  it("never collides with the /design preview samples (DIM-MUES-*)", () => {
    expect(QA_TOKEN_PREFIX).not.toBe("DIM-MUES-");
    // And the previews do not borrow a QA token either: a fixture pointing at
    // a QA pet would change under the battery's feet.
    const designDir = join("app", "(public)", "design");
    const sources = readdirSync(designDir, { recursive: true, encoding: "utf8" })
      .filter((entry) => /\.(tsx?|css)$/.test(entry))
      .map((entry) => readFileSync(join(designDir, entry), "utf8"));
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(source).not.toContain(QA_TOKEN_PREFIX);
  });

  it("names say they are QA — and still carry no seed marker in a renderable column", () => {
    // "QA …" is a word a person reads, not a marker the hygiene fence hunts
    // (PANO-, -Seed-, n-<digits>): it renders cleanly AND cannot pass for a pet.
    for (const pet of QA_PETS) {
      expect(pet.name).toMatch(/^QA [A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ ]+$/);
      expect(findSeedMarker(pet.name), pet.name).toBe(null);
    }
    const names = QA_PETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * Every pet name the OTHER fixtures use, read out of their sources — never a
 * hand-copied list, which would rot the day a fixture gains a pet. A pet is an
 * object literal that carries a `name` / `display_name` string AND something
 * only an animal has beside it (`species`, `sex`, `breed`, a public token), plus
 * the `petName` / `*PET_NAME` constants specs keep. The scan is deliberately wide
 * (every other seed, every e2e file): a false hit costs a rename, a miss costs
 * an e2e run that picks the wrong animal.
 */
function fixturePetNames(): Map<string, string> {
  const files: string[] = [];
  for (const f of readdirSync("scripts")) {
    if (/^seed-.*\.ts$/.test(f) && !f.startsWith("seed-situaciones"))
      files.push(join("scripts", f));
  }
  for (const f of readdirSync("e2e", { recursive: true, encoding: "utf8" })) {
    if (f.endsWith(".ts")) files.push(join("e2e", f));
  }
  const names = new Map<string, string>();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:display_)?name:\s*"([^"\n]+)"/g)) {
      const at = m.index ?? 0;
      const close = src.indexOf("}", at);
      const body = src.slice(src.lastIndexOf("{", at), close === -1 ? at + 400 : close);
      const isPet = /\b(species|sex|breed|public_?[tT]oken|token):/.test(body);
      if (isPet && m[1] && !names.has(m[1])) names.set(m[1], file);
    }
    for (const m of src.matchAll(/\b(?:[A-Za-z_]*PET_NAME|petName)\s*[:=]\s*"([^"\n]+)"/g)) {
      if (m[1] && !names.has(m[1])) names.set(m[1], file);
    }
  }
  return names;
}

describe("seed:situaciones — names never pass for a fixture's pet", () => {
  const fixtures = fixturePetNames();

  it("non-vacuity: the scan finds the e2e owner's pets and the demo seeds' pets", () => {
    // seed-test-users seeds owner@dim.test with these three; the specs lean on them.
    for (const name of ["Firulais", "Michi", "Atún"]) expect(fixtures.has(name), name).toBe(true);
    expect(fixtures.size).toBeGreaterThan(20);
  });

  it("no QA name equals, contains or is contained by a fixture pet name", () => {
    // Containment, not just equality: Playwright's `name:` matches substrings,
    // so "QA Kiwi" next to a fixture "Kiwi" would still be found by a spec.
    const clashes: string[] = [];
    for (const pet of QA_PETS) {
      const qa = pet.name.toLowerCase();
      for (const [fixture, file] of fixtures) {
        const other = fixture.toLowerCase();
        const word = new RegExp(
          `(^|[^a-záéíóúñ])${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-záéíóúñ])`,
        );
        if (qa === other || word.test(qa) || other.includes(qa)) {
          clashes.push(`${pet.token} "${pet.name}" vs "${fixture}" (${file})`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});

describe("seed:situaciones — coverage of PET_SITUATIONS", () => {
  it("non-vacuity: the product list is the nine situations of the owner page", () => {
    expect(ALL_SITUATIONS.length).toBeGreaterThanOrEqual(9);
  });

  it("every situation is seeded or explicitly declared unreachable, with a reason", () => {
    const reached = reachedSituations();
    for (const situation of ALL_SITUATIONS) {
      const reason = UNREACHABLE_SITUATIONS[situation];
      const answered = reached.has(situation) || (reason !== undefined && reason.length > 40);
      expect(answered, `${situation} is neither seeded nor declared unreachable`).toBe(true);
    }
  });

  it("never claims a situation both ways, nor one the product does not have", () => {
    const reached = reachedSituations();
    for (const key of Object.keys(UNREACHABLE_SITUATIONS) as PetSituationKey[]) {
      expect(ALL_SITUATIONS).toContain(key);
      expect(reached.has(key), `${key} is seeded AND declared unreachable`).toBe(false);
    }
    for (const pet of QA_PETS) expect(ALL_SITUATIONS).toContain(pet.situation);
  });

  it("carries the battery's variants: three lost, new, many notices, not-titular", () => {
    const recipes = new Set(QA_PETS.map((p) => p.recipe));
    for (const recipe of [
      "lost-disclosed-with-point",
      "lost-disclosed-without-point",
      "lost-not-disclosed",
      "new",
      "many-notices",
      "caretaker-not-titular",
    ] as const) {
      expect(recipes.has(recipe), recipe).toBe(true);
    }
    // The not-titular pet belongs to someone else; every other pet to owner@.
    expect(QA_PETS.filter((p) => p.titular === "owner2").map((p) => p.recipe)).toEqual([
      "caretaker-not-titular",
    ]);
    // The co-titular substitute says so, so nobody reads it as a co-owner.
    expect(UNREACHABLE_RELATIONSHIPS["co-titular"]).toContain("co_owner");
  });
});

describe("seed:situaciones — local-only guard", () => {
  const LOCAL_API = "http://127.0.0.1:54321";
  const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const REMOTE_API = "https://abcdefghijklmnopqrst.supabase.co";
  const REMOTE_DB =
    "postgresql://postgres.abcdefghijklmnopqrst:secret@aws-1-sa-east-1.pooler.supabase.com:6543/postgres";

  it("passes only when BOTH URLs are local", () => {
    expect(situacionesTargetProblem(LOCAL_API, LOCAL_DB)).toBeNull();
    expect(situacionesTargetProblem("http://localhost:54321", LOCAL_DB)).toBeNull();
  });

  it("refuses a fully remote target", () => {
    expect(situacionesTargetProblem(REMOTE_API, REMOTE_DB)).toMatch(/remoto/);
  });

  it("refuses a split env and names the remote half, either way round", () => {
    expect(situacionesTargetProblem(LOCAL_API, REMOTE_DB)).toMatch(/partido: DATABASE_URL/);
    expect(situacionesTargetProblem(REMOTE_API, LOCAL_DB)).toMatch(
      /partido: NEXT_PUBLIC_SUPABASE_URL/,
    );
  });

  it("refuses a missing URL instead of reading it as local", () => {
    expect(situacionesTargetProblem("", LOCAL_DB)).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(situacionesTargetProblem(LOCAL_API, "")).toMatch(/DATABASE_URL/);
  });

  it("compares hostnames, not substrings", () => {
    expect(
      situacionesTargetProblem("https://localhost.example.supabase.co", LOCAL_DB),
    ).not.toBeNull();
  });
});

describe("seed:situaciones — printed table", () => {
  it("prints token, situation and both URLs for every row", () => {
    const pet = QA_PETS[0];
    if (!pet) throw new Error("empty plan");
    const out = formatSituacionesTable([
      { token: pet.token, situation: pet.situation, label: pet.label, status: "ok", note: null },
    ]);
    expect(out).toContain(pet.token);
    expect(out).toContain(pet.situation);
    expect(out).toContain(`/p/${pet.token}`);
    expect(out).toContain(`/mis-mascotas/${pet.token}`);
  });
});
