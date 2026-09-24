// The rollback script's CLI contract and the docs that point at it
// (rehome-by-titular, design ADR-7; tasks 7.1 / 7.3). Layer: Unit (reads
// source, no DB). The behaviour against rows is __tests__/rollback-rehome-sponsorships.test.ts.
//
// WHY PIN THE CLI. The script exists for one night nobody planned: it runs
// BEFORE the app commit is reverted, by a person under pressure, against a
// remote database. Every property below is one that would hurt most when
// discovered in that moment — that `--apply` is opt-in, that a remote host
// needs an explicit flag, that it selects on the spine, that it refuses
// orphans, that the outcome it writes is the one reserved for it — so each is
// a line here, not a memory.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeTarget, isLocalWriterTarget } from "@/scripts/_db-target";

const REPO_ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("scripts/rollback-rehome-sponsorships.ts — CLI contract", () => {
  const src = read("scripts/rollback-rehome-sponsorships.ts");

  it("dry-run is the default; --apply is the only way to write", () => {
    expect(src).toMatch(/--apply/);
    expect(src).toMatch(/apply:\s*false/);
  });

  it("a remote DATABASE_URL is refused without --allow-remote, and the target is named", () => {
    expect(src).toMatch(/--allow-remote/);
    expect(src).toMatch(/describeTarget\(/);
  });

  it("selects on the spine through the adoption writer's predicate, never on the ownership shape", () => {
    expect(src).toMatch(/findOpenSponsorship\(/);
    expect(src).not.toMatch(/role,\s*"shelter_custody"\)[\s\S]{0,200}role,\s*"owner"\)/);
  });

  it("lists orphans through lint:spine's own query and never ends them", () => {
    expect(src).toMatch(/queryOrphanedSponsorships\(/);
    expect(src).toMatch(/SKIPPED \(orphan\)/);
  });

  it("writes the closing fact through the single writer, with the outcome reserved for the platform", () => {
    expect(src).toMatch(/endRehomeSponsorship\(/);
    expect(src).toMatch(/outcome:\s*"withdrawn_by_platform"/);
    expect(src).not.toMatch(/eventType:\s*"rehome_sponsorship_ended"/);
  });

  it("takes the pet advisory lock first, like every other custody writer of the feature", () => {
    expect(src).toMatch(/acquirePetAdvisoryLock\(/);
  });

  it("exports runRollback for the db test and only runs as a CLI when invoked directly", () => {
    expect(src).toMatch(/export async function runRollback\(/);
    expect(src).toMatch(/isMain/);
  });

  // WU6/7 review (L-2): the read-only fences trust `db`, `0.0.0.0` and
  // `host.docker.internal` as "a developer's own stack" — fine for a SKIP
  // decision on a read. A WRITER borrowing that list would write through a
  // DATABASE_URL whose host is literally `db` with no flag typed. A writer's
  // "local" is the Supabase CLI stack and nothing else.
  describe("a writer's 'local' is stricter than the read-only fences'", () => {
    const cases: Array<[string, boolean]> = [
      ["postgresql://postgres:postgres@localhost:54322/postgres", true],
      ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", true],
      ["postgresql://postgres:postgres@[::1]:54322/postgres", true],
      // The compose hostname and the Docker gateway: the fences' list, not ours.
      ["postgresql://postgres:postgres@db:5432/postgres", false],
      ["postgresql://postgres:postgres@host.docker.internal:54322/postgres", false],
      ["postgresql://postgres:postgres@0.0.0.0:54322/postgres", false],
      ["postgresql://postgres:postgres@supabase_db_dim:5432/postgres", false],
      // A local host on a port that is not the CLI stack's is somebody's
      // other Postgres — name it with the flag.
      ["postgresql://postgres:postgres@localhost:5432/postgres", false],
      ["postgresql://postgres:postgres@localhost/postgres", false],
      ["postgresql://postgres.ref:pw@aws-1-sa-east-1.pooler.supabase.com:5432/postgres", false],
      ["not a url", false],
    ];
    for (const [url, expected] of cases) {
      it(`${url.replace(/:[^:@/]+@/, ":***@")} -> ${expected}`, () => {
        expect(isLocalWriterTarget(describeTarget(url))).toBe(expected);
      });
    }

    it("the fences' broader list still trusts `db` — the writer must not borrow it", () => {
      expect(describeTarget("postgresql://postgres:postgres@db:5432/postgres").isLocal).toBe(true);
    });

    it("the script gates on isLocalWriterTarget, never on the fences' isLocal", () => {
      expect(src).toMatch(/isLocalWriterTarget\(/);
      expect(src).not.toMatch(/target\.isLocal\b/);
    });
  });
});

describe("the comments that said 'planned for WU7' now point at the script", () => {
  for (const rel of [
    "src/modules/adoption/infrastructure/rehome-sponsorship-writer.ts",
    "lib/events/rehome-event-schemas.ts",
  ]) {
    it(`${rel} no longer defers the rollback to a future work unit`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/planned for WU7/);
      expect(src).not.toMatch(/not yet in the tree/);
      expect(src).toContain("scripts/rollback-rehome-sponsorships.ts");
    });
  }
});

describe("src/modules/rehome/README.md — the module explains itself (task 7.3)", () => {
  const readme = read("src/modules/rehome/README.md");

  it("names the boundary rationale, the ADRs, the rollback ordering and the two meanings of custodia", () => {
    expect(readme).toMatch(/ADR-1/);
    expect(readme).toMatch(/ADR-7/);
    expect(readme).toMatch(/rollback-rehome-sponsorships/);
    expect(readme).toMatch(
      /BEFORE the app commit is reverted|before the app commit is reverted|antes de revertir/i,
    );
    expect(readme).toMatch(/custodia/i);
  });

  it("says WHY the rehome_sponsorship_ended writer lives in adoption", () => {
    expect(readme).toMatch(/rehome-sponsorship-writer/);
    expect(readme).toMatch(/acyclic|cycle/i);
  });
});
