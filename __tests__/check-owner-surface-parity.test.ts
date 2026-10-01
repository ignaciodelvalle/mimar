// The owner-surface parity fence, fenced.
//
// A CHECK NOBODY TESTS IS THE FAILURE THIS CHECK IS ABOUT. `scripts/check-
// owner-surface-parity.ts` exists because parity between the owner's web and
// the native app was tracked in prose and the prose rotted. The fence is a
// few hundred lines of import resolution and regex over the live tree; until
// this file existed nothing proved that a dropped kind is NAMED, that a
// renamed export FAILS rather than reporting parity, or that an exclusion
// without a reason is refused.
//
// THE LIVE TREE, MUTATED — not synthetic fixtures. The sibling icon fence
// tests against a hand-built table because its corpus is one file; this one
// reads a hundred, so every case below takes `collectInputs()` and edits ONE
// thing, which keeps each assertion about that one thing. The control case
// (the untouched tree passes) is what every other case is read against.

import { describe, expect, it } from "vitest";

import {
  DECLARED_DIVERGENCES,
  type DeclaredDivergence,
  MIN_COMPOSER_PROPERTIES,
  MIN_CONTRACT_API_KEYS,
  MIN_JOINED_ACTIONS,
  MIN_KINDS,
  MIN_OWNER_ACTIONS,
  MIN_OWNER_GUARDS,
  MIN_PROFILE_FIELDS,
  MIN_USE_SERVER_FILES,
  MIN_V1_USE_CASES,
  type ParityInputs,
  collectInputs,
  evaluate,
  kindsFromMobile,
  ownerActionsIn,
  ownerGuardNames,
  resolveUseCaseModule,
} from "@/scripts/check-owner-surface-parity";

const live: ParityInputs = collectInputs();

/** A shallow copy whose arrays can be replaced without touching `live`. */
function mutated(patch: Partial<ParityInputs>): ParityInputs {
  return { ...live, ...patch };
}

/** A "use server" file with one owner-guarded action reaching `useCase`. */
function syntheticAction(opts: {
  path: string;
  specifier: string;
  useCase: string;
  reads?: string;
}): { path: string; src: string } {
  return {
    path: opts.path,
    src: [
      '"use server";',
      `import { ${opts.useCase} } from "${opts.specifier}";`,
      'import { requirePetAccess } from "@/lib/infra/pet-access";',
      "export async function syntheticOwnerAction(publicToken: string) {",
      "  const access = await requirePetAccess(publicToken);",
      "  if (!access.ok) return { error: access.error };",
      `  const result = await ${opts.useCase}({ petId: access.pet.id });`,
      opts.reads
        ? `  return { ok: true, ${opts.reads}: result.value.${opts.reads} };`
        : "  return result;",
      "}",
    ].join("\n"),
  };
}

const failuresMatching = (failures: string[], needle: string) =>
  failures.filter((f) => f.includes(needle));

describe("check-owner-surface-parity — the fence is not vacuous", () => {
  it("passes the live tree, and every declared divergence is one the scan found", () => {
    const verdict = evaluate(live);
    expect(verdict.failures).toEqual([]);
    // Bidirectional: the declaration list IS the finding list, nothing more
    // and nothing less. A declared key the scan cannot find is stale; a found
    // key nobody declared is a failure above.
    const found = verdict.divergences.map((d) => d.key).sort();
    expect(found).toEqual(Object.keys(DECLARED_DIVERGENCES).sort());
  });

  it("measures every scan well above its floor (the floors are not the measurement)", () => {
    const c = evaluate(live).census;
    expect(c.ownerGuards.length).toBeGreaterThanOrEqual(MIN_OWNER_GUARDS);
    expect(c.useServerFiles).toBeGreaterThan(MIN_USE_SERVER_FILES);
    expect(c.ownerActions).toBeGreaterThan(MIN_OWNER_ACTIONS);
    expect(c.joinedActions).toBeGreaterThan(MIN_JOINED_ACTIONS);
    expect(c.v1UseCases).toBeGreaterThan(MIN_V1_USE_CASES);
    expect(c.contractApiKeys).toBeGreaterThan(MIN_CONTRACT_API_KEYS);
    expect(c.kinds.contract).toBeGreaterThan(MIN_KINDS);
    expect(c.kinds.mobile).toBe(c.kinds.contract);
    expect(c.kinds.router).toBe(c.kinds.contract);
  });

  it("the receipt dimension still reads fields off use-case results", () => {
    // `read:reportBiteAction.casePublicCode` WAS ASSERTED HERE and is gone
    // (2026-09-10), for the same reason `write:createTattooAction→
    // createTattooForUser` went before it: the divergence CLOSED.
    // `OwnerPetCasesSection` carries `casePublicCode` per open case now, so the
    // scan can no longer find it and an assertion that it is among the findings
    // would be an assertion that the gap is still open.
    //
    // What this test protected was NOT that one key: it was that the receipt
    // dimension exists at all — that the derivation still reads FIELDS off
    // use-case results and has not narrowed back to event kinds. So it asserts
    // that directly, on the live tree, against a literal the scan produces
    // rather than against the scan's own output shape.
    const receipts = live.webActionFiles.flatMap((f) =>
      ownerActionsIn(f, ownerGuardNames(live.guardSources)).flatMap((a) => [...a.receipt.values()]),
    );
    expect(receipts.flat().length).toBeGreaterThan(0);
  });
});

describe("the kind vocabulary — three sources that must agree", () => {
  it("(a) names the kind when the phone drops one", () => {
    const withoutBite = (live.mobileViewModel ?? "").replace('\n  "bite",\n', "\n");
    expect(withoutBite).not.toBe(live.mobileViewModel);
    const failures = evaluate(mutated({ mobileViewModel: withoutBite })).failures;
    const named = failuresMatching(failures, "contract and mobile disagree");
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("in contract only: bite");
    // The router still agrees with the contract: exactly one disagreement.
    expect(failuresMatching(failures, "contract and router disagree")).toEqual([]);
  });

  it("(b) fails on the floor, not on parity, when the export it reads is renamed", () => {
    const renamed = (live.mobileViewModel ?? "").replaceAll("WRITABLE_KINDS", "WRITEABLE_KINDS");
    expect(kindsFromMobile(renamed)).toBeNull();
    const failures = evaluate(mutated({ mobileViewModel: renamed })).failures;
    expect(failuresMatching(failures, "could not derive the mobile kind vocabulary")).toHaveLength(
      1,
    );
    // And it does NOT go on to report a disagreement it cannot compute.
    expect(failuresMatching(failures, "disagree")).toEqual([]);
  });

  it("fails on an unreadable contract or router source the same way", () => {
    expect(
      failuresMatching(
        evaluate(mutated({ contractRecordEvent: null })).failures,
        "could not derive the contract kind vocabulary",
      ),
    ).toHaveLength(1);
    expect(
      failuresMatching(
        evaluate(mutated({ routerWriters: null })).failures,
        "could not derive the router kind vocabulary",
      ),
    ).toHaveLength(1);
  });
});

describe("the join — a web door the app lacks is named", () => {
  it("names the action and the use-case when no v1 route reaches it", () => {
    const extra = syntheticAction({
      path: "src/modules/pets/synthetic-actions.ts",
      specifier: "./application/synthetic/do-something",
      useCase: "doSomething",
    });
    const verdict = evaluate(mutated({ webActionFiles: [...live.webActionFiles, extra] }));
    const named = failuresMatching(verdict.failures, "write:syntheticOwnerAction→doSomething");
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("src/modules/pets/application/synthetic/do-something");
  });

  it("names the field when the web reads a receipt fact no v1 read carries", () => {
    // createVaccination IS reached by v1 (the events router), so the action
    // joins; what it reads off the result is then judged.
    const extra = syntheticAction({
      path: "app/actions/synthetic.ts",
      specifier: "@/src/modules/events/application/medical/vaccination-use-case",
      useCase: "createVaccination",
      reads: "secretReceiptCode",
    });
    const verdict = evaluate(mutated({ webActionFiles: [...live.webActionFiles, extra] }));
    expect(
      failuresMatching(verdict.failures, "read:syntheticOwnerAction.secretReceiptCode"),
    ).toHaveLength(1);
    expect(failuresMatching(verdict.failures, "write:syntheticOwnerAction")).toEqual([]);
  });

  it("resolves the relative and the absolute spelling of one module to one id", () => {
    // The whole join rests on this: the web action inside src/modules/events
    // says `./application/x`, the v1 route says `@/src/modules/events/application/x`.
    expect(resolveUseCaseModule("src/modules/events/actions.ts", "./application/x/y")).toBe(
      "src/modules/events/application/x/y",
    );
    expect(
      resolveUseCaseModule("app/api/v1/z/route.ts", "@/src/modules/events/application/x/y"),
    ).toBe("src/modules/events/application/x/y");
    expect(resolveUseCaseModule("app/x.ts", "@/lib/infra/pets")).toBeNull();
    expect(
      resolveUseCaseModule("src/modules/events/actions.ts", "./infrastructure/repo"),
    ).toBeNull();
  });

  it("an empty app set fails the floor rather than declaring every web door a gap", () => {
    const failures = evaluate(mutated({ v1Files: [] })).failures;
    expect(failuresMatching(failures, "use-cases reached from app/api/v1 — found 0")).toHaveLength(
      1,
    );
  });

  it("an empty guard set fails the floor rather than seeing no owner actions", () => {
    const failures = evaluate(
      mutated({ guardSources: live.guardSources.map((g) => ({ ...g, src: "" })) }),
    ).failures;
    expect(failuresMatching(failures, "owner guard exports")).toHaveLength(1);
    expect(failuresMatching(failures, "owner-guarded actions — found 0")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The FIELD census (owner-pet-actions, 2026-10-01)
// ---------------------------------------------------------------------------
//
// The use-case join above saw parity where there was none: the app reached
// `updatePet` through `edit_identity`, so the join called the web's edit form
// covered — while the app could write three of its fields and the web fifteen.
// Sex, birth date, allergies, insurance, the public toggles: every one a gap,
// none visible. The census asks the question the join cannot: for every field
// the web's edit WRITES, can a v1 command write it too?

describe("the field census — every field the web's edit writes", () => {
  const composer = live.profileComposer ?? "";

  it("measures the live tree above its floors, and finds fields the app CAN write", () => {
    const c = evaluate(live).census;
    expect(c.profileFields).toBeGreaterThan(MIN_PROFILE_FIELDS);
    expect(c.composerProperties).toBeGreaterThan(MIN_COMPOSER_PROPERTIES);
    // Non-vacuity in the other direction: a census where nothing is writable
    // would be all divergences, and a declaration list that swallowed them all.
    expect(c.v1WritableFields).toBeGreaterThan(MIN_PROFILE_FIELDS / 2);
  });

  it("names a field the moment the composer stops writing it", () => {
    const line =
      "insuranceCompany: edit.insurance ? edit.insurance.insuranceCompany : existing.insuranceCompany,";
    expect(composer).toContain(line);
    const carried = composer.replace(line, "insuranceCompany: existing.insuranceCompany,");
    const named = failuresMatching(
      evaluate(mutated({ profileComposer: carried })).failures,
      "divergence not declared: field:insurance_company",
    );
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("composePetProfileEdit");
  });

  it("fails as it would have before edit_profile: no v1 call to the composer is no field at all", () => {
    // The world before owner-pet-actions phase 2, rebuilt by removing the one
    // call the v1 surface makes. Every field the web writes becomes a gap.
    const without = live.v1Files.map((f) => ({
      ...f,
      src: f.src.replaceAll("composePetProfileEdit(", "somethingElse("),
    }));
    const failures = evaluate(mutated({ v1Files: without })).failures;
    for (const field of ["name", "sex", "date_of_birth", "known_allergies", "insurance_company"]) {
      expect(failuresMatching(failures, `divergence not declared: field:${field}`)).toHaveLength(1);
    }
  });

  it("names a NEW field the web's diff starts writing that no v1 command writes", () => {
    const diff = live.petDiff ?? "";
    const anchor = '{ field: "color", oldVal: existing.color, newVal: parsed.color },';
    expect(diff).toContain(anchor);
    const grown = diff.replace(
      anchor,
      `${anchor}\n    { field: "distinguishing_features", oldVal: existing.color, newVal: parsed.distinguishingFeatures },`,
    );
    expect(
      failuresMatching(
        evaluate(mutated({ petDiff: grown })).failures,
        "divergence not declared: field:distinguishing_features",
      ),
    ).toHaveLength(1);
  });

  it("counts the toggle that writes without a diff entry — the census is not only diffPet's", () => {
    const line =
      "emergencyInfoVisible: edit.publicCredential\n      ? edit.publicCredential.emergencyInfoVisible\n      : existing.emergencyInfoVisible,";
    expect(composer).toContain(line);
    const carried = composer.replace(line, "emergencyInfoVisible: existing.emergencyInfoVisible,");
    expect(
      failuresMatching(
        evaluate(mutated({ profileComposer: carried })).failures,
        "divergence not declared: field:emergency_info_visible",
      ),
    ).toHaveLength(1);
  });

  it("fails the floor, not parity, when a source it reads is gone or reshaped", () => {
    expect(
      failuresMatching(
        evaluate(mutated({ profileComposer: null })).failures,
        "could not derive what composePetProfileEdit writes",
      ),
    ).toHaveLength(1);
    expect(
      failuresMatching(
        evaluate(mutated({ petDiff: null })).failures,
        "could not derive the profile field list",
      ),
    ).toHaveLength(1);
    // A renamed diff function reads as no fields — never as no gaps.
    const renamed = (live.petDiff ?? "").replace(
      "export function diffPet(",
      "export function diff(",
    );
    expect(
      failuresMatching(
        evaluate(mutated({ petDiff: renamed })).failures,
        "could not derive the profile field list",
      ),
    ).toHaveLength(1);
  });
});

describe("the declarations — explicit, reasoned, live", () => {
  // Any LIVE declared key will do for the two substitution tests below. It is
  // taken from the list itself rather than named: a named key goes stale the
  // day its divergence closes (it happened twice — reportBiteAction on
  // 2026-09-10, togglePhysicalTagInterestAction with D2 on 2026-09-25), and a
  // key the scan no longer finds makes these tests fail — or pass — for the
  // wrong reason. "refuses a declaration the scan no longer finds" is what
  // keeps every declared key live.
  const LIVE_KEY = Object.keys(DECLARED_DIVERGENCES)[0] as string;

  it("has at least one live declaration to substitute", () => {
    expect(LIVE_KEY).toBeDefined();
    expect(evaluate(live, DECLARED_DIVERGENCES).failures).toEqual([]);
  });

  it("refuses an entry without a reason or without what would close it", () => {
    const hollow: Record<string, DeclaredDivergence> = {
      ...DECLARED_DIVERGENCES,
      [LIVE_KEY]: {
        reason: "  ",
        closes: "",
      },
    };
    const failures = evaluate(live, hollow).failures;
    expect(failuresMatching(failures, "declared without a reason")).toHaveLength(1);
  });

  it("refuses a declaration the scan no longer finds", () => {
    const stale: Record<string, DeclaredDivergence> = {
      ...DECLARED_DIVERGENCES,
      "write:ghostAction→ghostUseCase": { reason: "was true once", closes: "nothing" },
    };
    const failures = evaluate(live, stale).failures;
    const named = failuresMatching(failures, "stale declaration");
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("write:ghostAction→ghostUseCase");
  });

  it("refuses an undeclared divergence, naming the remedy", () => {
    // Same substitution as above, and for the same reason: this needs a
    // divergence the scan STILL finds, so that dropping its declaration is what
    // produces the failure.
    const { [LIVE_KEY]: _dropped, ...rest } = DECLARED_DIVERGENCES;
    const failures = evaluate(live, rest).failures;
    const named = failuresMatching(failures, `divergence not declared: ${LIVE_KEY}`);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("DECLARED_DIVERGENCES");
  });
});
