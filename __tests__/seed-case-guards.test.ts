// DB-backed test for scripts/seed-case-guards.ts.
//
// Why this file exists: `seed-panorama.ts` used to pick the pets it opens cases
// on with an unordered `select ... from pets where public_token like 'PANO-%'
// limit N`. Postgres answers that with PHYSICAL heap order, which shifts as the
// seed UPDATEs pets rows along the way — so two steps that both open cases saw
// different slices on different runs, and whenever the later step's pick landed
// on a pet the earlier step had already opened a custody_dispute for, the seed
// died mid-run with
//   duplicate key value violates unique constraint "cases_open_per_pet_kind_idx"
// That is an intermittent CI failure with no code change behind it.
//
// The guard makes the collision impossible BY CONSTRUCTION rather than
// unlikely: the same predicate the partial unique index uses, expressed as a
// NOT EXISTS, plus a deterministic ORDER BY. These tests pin both halves —
// including the negative case (a pet with an open case of that kind is never
// returned) and the migration-parity case (the guard's kind/status lists still
// match db/migrations/0033_cases.sql).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pets } from "@/db";
import {
  CASE_KINDS_ALLOWING_MULTIPLE_OPEN,
  OPEN_CASE_STATUSES,
  findOpenCasesOfKind,
  kindIsSingleOpenPerPet,
  selectPetsWithoutOpenCase,
  selectSeedPetsOrdered,
} from "../scripts/seed-case-guards";
import { withMutationOverride } from "./_helpers/db-overrides";

const PREFIX = "DIM-GUARD-";
const TOKENS = [`${PREFIX}P3`, `${PREFIX}P1`, `${PREFIX}P2`] as const;
const CASE_PREFIX = "CAS-GUARD-";

const petIdByToken = new Map<string, string>();

async function cleanup(): Promise<void> {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM cases WHERE public_code LIKE ${`${CASE_PREFIX}%`}`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token LIKE ${`${PREFIX}%`}
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token LIKE ${`${PREFIX}%`}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token LIKE ${`${PREFIX}%`}`);
  });
}

async function openCase(token: string, caseKind: string, code: string): Promise<void> {
  const petId = petIdByToken.get(token);
  await db.execute(sql`
    INSERT INTO cases (
      public_code, case_kind, status, primary_subject_kind, primary_pet_id,
      jurisdiction_country, jurisdiction_province, jurisdiction_locality,
      opened_reason, opened_at
    ) VALUES (
      ${code}, ${caseKind}, 'open', 'registered_pet', ${petId},
      'AR', 'Buenos Aires', 'La Plata',
      'auto: disputa de custodia entre partes', now()
    )
  `);
}

beforeAll(async () => {
  await cleanup();

  // Inserted in a deliberately NON-alphabetical order so the ordering
  // assertion below can only pass if the query really sorts.
  for (const token of TOKENS) {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: "GuardTest",
        species: "dog",
        sex: "unknown",
        potentiallyDangerousBreed: false,
        jurisdictionProvince: "Buenos Aires",
        jurisdictionLocality: "La Plata",
      })
      .returning({ id: pets.id });
    petIdByToken.set(token, row.id);
  }
});

afterAll(async () => {
  await cleanup();
});

describe("selectSeedPetsOrdered — the pick is reproducible", () => {
  it("returns pets sorted by public_token, not in heap order", async () => {
    const rows = await selectSeedPetsOrdered({ tokenPrefix: PREFIX, limit: 10 });
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("returns the same slice on repeated calls", async () => {
    const a = await selectSeedPetsOrdered({ tokenPrefix: PREFIX, limit: 2 });
    const b = await selectSeedPetsOrdered({ tokenPrefix: PREFIX, limit: 2 });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(a).toHaveLength(2);
  });
});

describe("selectPetsWithoutOpenCase — one open case per pet per kind", () => {
  it("returns every pet while none has an open case of that kind", async () => {
    const rows = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_dispute",
      limit: 10,
    });
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("excludes a pet that already has an OPEN case of that kind", async () => {
    await openCase(`${PREFIX}P1`, "custody_dispute", `${CASE_PREFIX}DISP-1`);

    const rows = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_dispute",
      limit: 10,
    });
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P2`, `${PREFIX}P3`]);
  });

  it("still returns that pet for a DIFFERENT kind — the index is per (pet, kind)", async () => {
    const rows = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_episode",
      limit: 10,
    });
    expect(rows.map((r) => r.publicToken)).toContain(`${PREFIX}P1`);
  });

  it("the pet it returns is a LEGAL insert target — the index accepts it", async () => {
    const [first] = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_dispute",
      limit: 10,
    });
    expect(first.publicToken).toBe(`${PREFIX}P2`);
    expect(await findOpenCasesOfKind(first.id, "custody_dispute")).toEqual([]);

    // The real proof: the DB accepts the insert the seed would make.
    await openCase(first.publicToken, "custody_dispute", `${CASE_PREFIX}DISP-2`);
    expect(await findOpenCasesOfKind(first.id, "custody_dispute")).toHaveLength(1);

    // …and the guard immediately stops offering it.
    const after = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_dispute",
      limit: 10,
    });
    expect(after.map((r) => r.publicToken)).toEqual([`${PREFIX}P3`]);
  });

  it("a CLOSED case does not block the pet — the index predicate is status-scoped", async () => {
    await db.execute(sql`
      UPDATE cases SET status = 'closed', closed_at = now(), closed_reason = 'resolved'
      WHERE public_code = ${`${CASE_PREFIX}DISP-1`}
    `);

    const rows = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "custody_dispute",
      limit: 10,
    });
    expect(rows.map((r) => r.publicToken)).toEqual([`${PREFIX}P1`, `${PREFIX}P3`]);
  });

  it("does not filter kinds the index explicitly allows to be multiply open", async () => {
    // welfare_denuncia is one of the four excluded kinds: several open ones on
    // the same pet are legal, so the guard must not silently drop candidates.
    await openCase(`${PREFIX}P1`, "welfare_denuncia", `${CASE_PREFIX}WELF-1`);

    const rows = await selectPetsWithoutOpenCase({
      tokenPrefix: PREFIX,
      caseKind: "welfare_denuncia",
      limit: 10,
    });
    expect(rows.map((r) => r.publicToken)).toContain(`${PREFIX}P1`);
  });
});

describe("guard constants match db/migrations/0033_cases.sql", () => {
  const migration = readFileSync(join(process.cwd(), "db", "migrations", "0033_cases.sql"), "utf8");
  const indexDdl =
    migration
      .split(/create unique index if not exists cases_open_per_pet_kind_idx/i)[1]
      ?.split(";")[0] ?? "";

  it("finds the partial unique index in the migration", () => {
    expect(indexDdl).not.toBe("");
    expect(indexDdl).toMatch(/on public\.cases \(primary_pet_id, case_kind\)/i);
  });

  it("mirrors the index's open statuses", () => {
    for (const status of OPEN_CASE_STATUSES) {
      expect(indexDdl).toContain(`'${status}'`);
    }
    const statusList = indexDdl.match(/status in \(([^)]*)\)/i)?.[1] ?? "";
    const parsed = [...statusList.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(parsed).toEqual([...OPEN_CASE_STATUSES].sort());
  });

  it("mirrors the index's exempt kinds", () => {
    const kindList = indexDdl.match(/case_kind not in \(([^)]*)\)/i)?.[1] ?? "";
    const parsed = [...kindList.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(parsed).toEqual([...CASE_KINDS_ALLOWING_MULTIPLE_OPEN].sort());
  });

  it("classifies constrained vs unconstrained kinds accordingly", () => {
    expect(kindIsSingleOpenPerPet("custody_dispute")).toBe(true);
    expect(kindIsSingleOpenPerPet("custody_episode")).toBe(true);
    for (const kind of CASE_KINDS_ALLOWING_MULTIPLE_OPEN) {
      expect(kindIsSingleOpenPerPet(kind)).toBe(false);
    }
  });
});
