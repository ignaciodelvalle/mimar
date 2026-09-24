// Which seed is behind the origin under test — the ONLY thing a fixture-gated
// e2e check is allowed to branch on.
//
// Dependency-free ON PURPOSE (same rationale as _page-identity.ts): the
// decision is a pure function pinned by __tests__/e2e-seed-profile.test.ts, so
// it cannot rot inside a spec nobody can unit-test.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// e2e/public-smoke.spec.ts had three gates of the shape
//
//     test.skip((await link.count()) === 0, "NO COVERAGE: …");
//
// on DATA PRESENCE. Two of them are axe scans, one of them on the surface the
// file itself calls "the hero moment" under Ley 26.653. A skip keyed on data
// self-retires: the day a seed stops publishing a lost pet, the gate stops
// running and the summary stays green — which is exactly what happened, the
// comments in that file admit it, and nobody was paged.
//
// A skip keyed on the ENVIRONMENT cannot do that. There are two, and only two,
// e2e environments in this project (e2e/README.md · Conventions):
//
//   · "bootstrap" — `pnpm db:bootstrap`: reference data + seed-test-users and
//     STOPS. No cases, no lost pets, no adoption listings, no share tokens.
//     This is what CI's e2e job runs (.github/workflows/ci.yml) and what the
//     local :3333 config builds against. An empty /perdidas here is the
//     DOCUMENTED state of the seed, not a defect — the fixture gap is real but
//     it must be closed in scripts/, not papered over with a red spec.
//   · "full" — the deployed staging origin the nightly pass drives
//     (dim-interno:.github/workflows/e2e-nightly.yml → playwright.staging.config.ts).
//     It carries the demo/storyline seeds: measured 2026-08-04, /perdidas
//     listed 317 active lost pets and /adoptar 3 published listings. A MISSING
//     fixture here is a regression in the seed or in the listing route, and it
//     must be RED.
//
// So the gate below skips only where absence is documented, and FAILS
// everywhere else. A gate that cannot find its fixture in an environment that
// is supposed to have one is a failure, not a shrug.

export type SeedProfile = "bootstrap" | "full";

/**
 * Resolve the seed profile from the environment.
 *
 * Order:
 *   1. `E2E_SEED_PROFILE` — explicit override ("bootstrap" | "full"). Use it
 *      when driving a locally seeded QA DB (scripts/seed-panorama.ts et al.)
 *      through playwright.local3000.config.ts, where the data IS there and a
 *      missing fixture should be red.
 *   2. `STAGING_URL` — set by the nightly workflow and by any ad-hoc staging
 *      pass; its presence IS the "deployed, fully seeded origin" signal.
 *   3. Default "bootstrap" — the conservative answer. Guessing "full" here
 *      would turn every CI e2e run red on a seed gap CI cannot fix.
 */
export function resolveSeedProfile(env: Record<string, string | undefined>): SeedProfile {
  const explicit = env.E2E_SEED_PROFILE?.trim().toLowerCase();
  if (explicit === "full" || explicit === "bootstrap") return explicit;
  if (env.STAGING_URL?.trim()) return "full";
  return "bootstrap";
}

export const SEED_PROFILE: SeedProfile = resolveSeedProfile(process.env);

export type SeedFixtureVerdict =
  | { verdict: "run" }
  | { verdict: "skip"; reason: string }
  | { verdict: "fail"; reason: string };

/**
 * What a fixture-gated check should do when its fixture is (or isn't) there.
 *
 * @param found      how many instances of the fixture the page yielded.
 * @param fixture    what was looked for, in one phrase ("a lost pet on /perdidas").
 * @param untested   what goes unmeasured when it is absent — named, so a skip
 *                   in the summary reads as the coverage hole it is.
 * @param profile    the environment's seed profile.
 */
export function seedFixtureVerdict(
  found: number,
  fixture: string,
  untested: string,
  profile: SeedProfile = SEED_PROFILE,
): SeedFixtureVerdict {
  if (found > 0) return { verdict: "run" };
  if (profile === "full") {
    return {
      verdict: "fail",
      reason: [
        `FIXTURE MISSING on a fully seeded origin: found no ${fixture}, so ${untested} was not measured.`,
        'Seed profile "full" (STAGING_URL / E2E_SEED_PROFILE) promises this fixture exists — either the',
        "seed regressed or the listing route stopped rendering it. This is a failure, not a skip.",
        "If the origin genuinely has no such data, run with E2E_SEED_PROFILE=bootstrap and say why.",
      ].join(" "),
    };
  }
  return {
    verdict: "skip",
    reason: [
      `NO COVERAGE (seed profile "bootstrap"): found no ${fixture}, so ${untested} did not run.`,
      "pnpm db:bootstrap seeds reference data + test users and stops — this is the documented state of",
      "that seed (e2e/README.md), a fixture gap to close in scripts/, not a flake. The same check FAILS",
      "on the nightly staging pass, where the fixture is expected to exist.",
    ].join(" "),
  };
}
