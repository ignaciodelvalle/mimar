// Tests for the sponsored-custody hand-off fence.
// Layer: Unit (no DB, no Next.js). Spec REQ-15.
//
// A fence green on fixtures alone proves only that the fixtures work. So this
// file has four kinds of test, and the last two are the ones that matter:
//
//   1. Positive controls — hand-written sources that MUST be flagged, one per
//      shape that can hide a hand-off.
//   2. Negative controls — the same source with the guard, which must pass.
//   3. Adversarial controls — a guard named only in a comment, a read of the
//      event type dressed up as a write, a declarative lifecycle table.
//   4. Real-tree assertions — the live repo's own sites, pinned BY NAME,
//      because the believable failure of a fence is not misjudging a site: it
//      is never opening the file.

import { describe, expect, it } from "vitest";

import {
  CUSTODY_HANDOFF_ALLOWLIST,
  CUSTODY_HANDOFF_EVENT_TYPES,
  MAX_GUARDED_UNITS,
  MIN_HANDOFF_SITES,
  MIN_ORG_TO_ORG_SITES,
  MIN_SCANNED_FILES,
  SPONSORSHIP_GUARD,
  allSites,
  extractFunctions,
  findHandoffSites,
  findUnguardedHandoffs,
  indexGuardedFunctions,
  listScanSources,
} from "../scripts/check-custody-handoff-sponsorship";
import { stripComments } from "../scripts/lib/strip-comments.mjs";

// `listScanSources` hands the analysis comment-stripped text; the fixtures must
// arrive the same way or the adversarial "guard named only in a comment" case
// would be testing a pipeline that does not exist.
const src = (relPath: string, body: string) => ({ relPath, src: stripComments(body) });

// ---------------------------------------------------------------------------
// 1 + 2. Positive and negative controls
// ---------------------------------------------------------------------------

const ORG_TO_ORG_WRITE = `
export async function handOffToAnotherOrg(input: In, deps: Deps) {
  const custody = await repo.findActiveShelterCustody(pet.id, organization.id);
  await repo.insertPetEvent({
    petId: pet.id,
    eventType: "custody_transfer_proposed",
    payload: {
      from_user_id: null,
      from_organization_id: organization.id,
      to_user_id: null,
      to_organization_id: receiver.id,
      from_role: "shelter_custody",
      to_role: "shelter_custody",
    },
  });
}
`;

describe("the third door — an org-to-org hand-off with no guard", () => {
  it("flags a new hand-off writer that never reaches the guard", () => {
    const sources = [src("src/modules/newdoor/application/hand-off.ts", ORG_TO_ORG_WRITE)];
    const offenders = findUnguardedHandoffs(sources);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].site.fn).toBe("handOffToAnotherOrg");
    expect(offenders[0].site.direction).toBe("org_to_org");
    expect(offenders[0].problem).toContain(SPONSORSHIP_GUARD);
  });

  it("passes once the guard is called in the same function", () => {
    const guarded = ORG_TO_ORG_WRITE.replace(
      "await repo.insertPetEvent({",
      `const rule = ${SPONSORSHIP_GUARD}({ sourceCustodyId: custody.id, openSponsorship: s });\n  if (!rule.ok) return rule;\n  await repo.insertPetEvent({`,
    );
    expect(
      findUnguardedHandoffs([src("src/modules/newdoor/application/hand-off.ts", guarded)]),
    ).toEqual([]);
  });

  it("accepts the OTHER answer — ending the sponsorship rather than refusing", () => {
    const authority = ORG_TO_ORG_WRITE.replace(
      "await repo.insertPetEvent({",
      'await endAllLiveOwnerships({ petId, sponsorshipOutcome: "withdrawn_by_platform" }, tx);\n  await repo.insertPetEvent({',
    );
    expect(
      findUnguardedHandoffs([src("src/modules/decomiso/application/seize.ts", authority)]),
    ).toEqual([]);
  });

  it("passes when the guard is two calls away — the shape accept-cross-org-transfer uses", () => {
    const helperFile = `
async function refuseIfSponsored(repo, args, tx) {
  const rule = ${SPONSORSHIP_GUARD}({ sourceCustodyId: args.id, openSponsorship: null });
  if (!rule.ok) throw new Error(rule.error);
}
async function refuseIfSponsoredOuter(repo, args, tx) {
  await refuseIfSponsored(repo, args, tx);
}
`;
    const writer = ORG_TO_ORG_WRITE.replace(
      "await repo.insertPetEvent({",
      "await refuseIfSponsoredOuter(repo, { id: custody.id }, tx);\n  await repo.insertPetEvent({",
    );
    expect(
      findUnguardedHandoffs([
        src("src/modules/newdoor/application/guards.ts", helperFile),
        src("src/modules/newdoor/application/hand-off.ts", writer),
      ]),
    ).toEqual([]);
  });

  it("flags the completed move too, not only the proposal", () => {
    const completed = ORG_TO_ORG_WRITE.replace("custody_transfer_proposed", "custody_transferred");
    const offenders = findUnguardedHandoffs([src("src/modules/newdoor/a.ts", completed)]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].site.eventType).toBe("custody_transferred");
  });

  it("flags the validateEventPayload construction form, which carries no `payload:` key", () => {
    const decomisoShape = `
export async function seizeAndHandOff(ctx) {
  const transferPayload = validateEventPayload("custody_transferred", {
    from_user_id: null,
    from_organization_id: govtOrgId,
    to_user_id: null,
    to_organization_id: ctx.organization.id,
    from_role: "shelter_custody",
  });
  await tx.insert(petEvents).values({
    petId: petId,
    eventType: "custody_transferred",
    payload: transferPayload,
  });
}
`;
    const offenders = findUnguardedHandoffs([
      src("src/modules/x/application/seize.ts", decomisoShape),
    ]);
    // ONE offender, not two: the payload construction and the insert are the
    // same event expressed twice.
    expect(offenders).toHaveLength(1);
    expect(offenders[0].site.direction).toBe("org_to_org");
  });
});

// ---------------------------------------------------------------------------
// 3. Adversarial controls
// ---------------------------------------------------------------------------

describe("what the fence must NOT be fooled by", () => {
  it("does not accept a guard that exists only in a comment", () => {
    const commented = ORG_TO_ORG_WRITE.replace(
      "await repo.insertPetEvent({",
      `// This is safe because ${SPONSORSHIP_GUARD}() already ran upstream.\n  await repo.insertPetEvent({`,
    );
    expect(
      findUnguardedHandoffs([src("src/modules/newdoor/application/hand-off.ts", commented)]),
    ).toHaveLength(1);
  });

  it("does not read a query predicate as a write", () => {
    const read = `
export async function listProposals(petId: string) {
  return db.select().from(petEvents).where(
    and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")),
  );
}
`;
    expect(findHandoffSites(src("app/(app)/x/page.tsx", read))).toEqual([]);
  });

  it("does not read a declarative case lifecycle as a write", () => {
    const lifecycle = `
export const custodyTransferHandshakeLifecycle: CaseLifecycle = {
  kind: "custody_transfer_handshake",
  opensEvents: [{ eventType: "custody_transfer_proposed" }],
  terminalEvents: ["custody_transferred"],
};
`;
    expect(findHandoffSites(src("src/modules/cases/domain/lifecycles/x.ts", lifecycle))).toEqual(
      [],
    );
  });

  it("skips a move with a person at either end — the guard has no custody row to key on", () => {
    const toOwner = `
export async function returnToOwner(ctx) {
  await repo.insertPetEvent({
    eventType: "custody_transferred",
    payload: {
      from_user_id: null,
      from_organization_id: orgId,
      to_user_id: ownerUserId,
      to_organization_id: null,
      from_role: "shelter_custody",
    },
  });
}
`;
    const sites = findHandoffSites(src("src/modules/return-to-owner/application/r.ts", toOwner));
    expect(sites).toHaveLength(1);
    expect(sites[0].direction).toBe("not_org_to_org");
    expect(
      findUnguardedHandoffs([src("src/modules/return-to-owner/application/r.ts", toOwner)]),
    ).toEqual([]);
  });

  it("refuses to guess when the record leaves an end undeclared", () => {
    const vague = `
export async function mysteryMove(ctx) {
  await repo.insertPetEvent({
    eventType: "custody_transferred",
    payload: { from_role: "shelter_custody", to_role: "shelter_custody" },
  });
}
`;
    const offenders = findUnguardedHandoffs([src("src/modules/x/application/m.ts", vague)]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].problem).toContain("does not guess");
  });

  // -------------------------------------------------------------------------
  // Regressions for the six defects a fresh-context reviewer found on
  // 2026-08-25, four of which failed silently. Each one is a way this fence
  // could have said "clean" about a real third door.
  // -------------------------------------------------------------------------

  it("sees a hand-off written through a spread payload instead of dropping it", () => {
    const spread = `
export async function spreadHandOff(ctx) {
  await repo.insertPetEvent({ petId, eventType: "custody_transferred", ...eventFields });
}
`;
    const sites = findHandoffSites(src("lib/infra/x.ts", spread));
    expect(sites).toHaveLength(1);
    expect(sites[0].direction).toBe("undeclared");
    expect(findUnguardedHandoffs([src("lib/infra/x.ts", spread)])).toHaveLength(1);
  });

  it("does not read an all-null payload as person-bound", () => {
    const allNull = `
export async function nullHandOff(ctx) {
  await repo.insertPetEvent({
    eventType: "custody_transferred",
    payload: {
      from_user_id: null,
      from_organization_id: null,
      to_user_id: null,
      to_organization_id: null,
      from_role: "shelter_custody",
    },
  });
}
`;
    const sites = findHandoffSites(src("src/modules/x/application/n.ts", allNull));
    expect(sites[0].direction).toBe("undeclared");
  });

  it("sees a hand-off whose event type hides behind a local constant", () => {
    const aliased = `
const HANDOFF = "custody_transferred";
export async function aliasedHandOff(ctx) {
  await repo.insertPetEvent({
    eventType: HANDOFF,
    payload: { from_organization_id: a.id, to_organization_id: b.id },
  });
}
`;
    expect(findUnguardedHandoffs([src("src/modules/x/application/a.ts", aliased)])).toHaveLength(1);
  });

  it("does not cry wolf about a SELECT that projects the eventType column", () => {
    const select = `
export async function readEvents(petId: string) {
  return db
    .select({ eventType: petEvents.eventType, payload: petEvents.payload })
    .from(petEvents)
    .where(eq(petEvents.eventType, "custody_transferred"));
}
`;
    expect(findHandoffSites(src("lib/analytics/x.ts", select))).toEqual([]);
  });

  it("credits the guard even when the payload is hoisted out of the insert", () => {
    const hoisted = `
export async function hoistedButGuarded(input, deps) {
  const custody = await repo.findActiveShelterCustody(pet.id, org.id);
  const rule = ${SPONSORSHIP_GUARD}({ sourceCustodyId: custody.id, openSponsorship: s });
  if (!rule.ok) return rule;
  const payload = { from_organization_id: org.id, to_organization_id: receiver.id };
  await repo.insertPetEvent({ petId: pet.id, eventType: "custody_transfer_proposed", payload });
}
`;
    expect(findUnguardedHandoffs([src("src/modules/x/application/h.ts", hoisted)])).toEqual([]);
  });

  it("does not split a function at a nested const arrow between the guard and the write", () => {
    const split = `
export async function guardedButSplit(input, deps) {
  const rule = ${SPONSORSHIP_GUARD}({ sourceCustodyId: c.id, openSponsorship: s });
  if (!rule.ok) return rule;
  const body = (n) => "Propuesta para " + n;
  await repo.insertPetEvent({
    eventType: "custody_transfer_proposed",
    payload: { from_organization_id: a.id, to_organization_id: b.id },
  });
}
`;
    const source = src("src/modules/x/application/s.ts", split);
    expect(findHandoffSites(source)[0].fn).toBe("guardedButSplit");
    expect(findUnguardedHandoffs([source])).toEqual([]);
  });

  it("does not credit a guard through a function name shared with an unguarded twin", () => {
    // The defect that let `submit`, `handleSubmit`, `ext` and `cleanupOrphan`
    // into the guarded set: bare-name matching. Two `cleanupOrphan`s exist in
    // this repo, in unrelated modules; one must not vouch for the other.
    const guardedTwin = `
export async function cleanupOrphan(petId) {
  await ${SPONSORSHIP_GUARD}({ sourceCustodyId: petId, openSponsorship: null });
}
`;
    const unguardedTwin = `
export async function cleanupOrphan(petId) {
  return petId;
}
export async function newDoor(ctx) {
  await cleanupOrphan(ctx.petId);
  await repo.insertPetEvent({
    eventType: "custody_transferred",
    payload: { from_organization_id: a.id, to_organization_id: b.id },
  });
}
`;
    const offenders = findUnguardedHandoffs([
      src("src/modules/alpha/application/a.ts", guardedTwin),
      src("src/modules/beta/application/b.ts", unguardedTwin),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].site.fn).toBe("newDoor");
  });

  it("does not mistake a return type's braces for a function body", () => {
    // The defect that made the first draft report the repo's OWN guarded
    // use-cases as offenders: the first `{` after `transferCustody(` opens
    // `Promise<UseCaseResult<{ … }>>`, not the body.
    const typed = `
export async function guardedHandOff(
  input: In,
  deps: Deps,
): Promise<UseCaseResult<{ publicCode: string; caseId: string }>> {
  const rule = ${SPONSORSHIP_GUARD}({ sourceCustodyId: c.id, openSponsorship: s });
  if (!rule.ok) return rule;
  await repo.insertPetEvent({
    eventType: "custody_transfer_proposed",
    payload: { from_organization_id: a.id, to_organization_id: b.id, from_user_id: null, to_user_id: null },
  });
}
`;
    const source = src("src/modules/x/application/g.ts", typed);
    expect(extractFunctions(source).map((u) => u.name)).toContain("guardedHandOff");
    expect(
      indexGuardedFunctions([source]).has("src/modules/x/application/g.ts#guardedHandOff"),
    ).toBe(true);
    expect(findUnguardedHandoffs([source])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. The real tree
// ---------------------------------------------------------------------------

describe("the live repository", () => {
  const sources = listScanSources();
  const sites = allSites(sources);

  it("opens a plausible corpus — the floors the CLI enforces without a test runner", () => {
    expect(sources.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(sites.length).toBeGreaterThanOrEqual(MIN_HANDOFF_SITES);
    expect(sites.filter((s) => s.direction === "org_to_org").length).toBeGreaterThanOrEqual(
      MIN_ORG_TO_ORG_SITES,
    );
  });

  // The glob that was missing, and the reason it mattered: lib/infra writes pet
  // events directly, and the fence's own failure message points authors there.
  it("opens lib/**, the directory a third door would most naturally live in", () => {
    expect(sources.some((s) => s.relPath === "lib/infra/end-pet-ownerships.ts")).toBe(true);
    expect(sources.filter((s) => s.relPath.startsWith("lib/")).length).toBeGreaterThan(300);
  });

  // The CEILING. The guarded set is the default-ALLOW surface; the three floors
  // measure only how much was examined.
  it("keeps the guarded set small and free of generic handler names", () => {
    const guarded = indexGuardedFunctions(sources);
    expect(guarded.size).toBeLessThanOrEqual(MAX_GUARDED_UNITS);
    const names = [...guarded].map((k) => k.split("#")[1]);
    for (const generic of ["submit", "handleSubmit", "handleAccept", "handleConfirm", "ext"]) {
      expect(names, `${generic} must not be able to vouch for a hand-off`).not.toContain(generic);
    }
    // Every entry is fully qualified — a bare name would be the old defect back.
    for (const k of guarded) expect(k).toMatch(/^[^#]+#[^#]+$/);
  });

  // Pinned BY NAME. A fence that stopped opening these files would still report
  // a clean tree, and the floors above would not catch a loss of two or three.
  it.each([
    ["src/modules/transfers/application/transfer-custody.ts", "transferCustody"],
    ["src/modules/transfers/application/propose-cross-org-transfer.ts", "proposeCrossOrgTransfer"],
    ["src/modules/transfers/application/accept-cross-org-transfer.ts", "acceptCrossOrgTransfer"],
    ["src/modules/decomiso/application/execute-decomiso.ts", "executeDecomiso"],
    ["src/modules/decomiso/application/reassign-decomiso.ts", "reassignDecomisoInTx"],
    ["src/modules/decomiso/application/accept-decomiso-handoff.ts", "acceptDecomisoHandoffInTx"],
    ["src/modules/custody-disputes/application/resolve-dispute.ts", "resolveDisputeUseCase"],
  ])("still sees the org-to-org hand-off in %s", (relPath, fn) => {
    const site = sites.find((s) => s.relPath === relPath && s.fn === fn);
    expect(site, `${relPath}#${fn} disappeared from the scan`).toBeDefined();
    expect(site?.direction).toBe("org_to_org");
  });

  // The transitive closure is not a synthetic capability here: this is the
  // repo's own two-hop chain, acceptCrossOrgTransfer → refuseIfSponsoredCustody
  // → validateSourceNotSponsored.
  it("reaches the guard through accept-cross-org-transfer's module-local helper", () => {
    const guarded = indexGuardedFunctions(sources);
    const accept = "src/modules/transfers/application/accept-cross-org-transfer.ts";
    expect(guarded.has(`${accept}#refuseIfSponsoredCustody`)).toBe(true);
    expect(guarded.has(`${accept}#acceptCrossOrgTransfer`)).toBe(true);
  });

  // The OTHER answer, and the reason this fence accepts two. The authority
  // paths do not refuse — they end the sponsorship with an explicit
  // `sponsorshipOutcome`, which `endAllLiveOwnerships` makes unskippable by
  // requiring it in the argument type. Both are live today; a fence that
  // demanded only the refusal would have been wrong about both.
  // The keys are FULLY QUALIFIED, and that is the point of the test as much as
  // the acceptance is: `executeDecomiso` is also the name of a React client
  // handler in app/gob/decomisos/nuevo/_components/DecomisoForm.tsx, and the
  // bare-name version of this assertion could not tell the two apart.
  it.each([
    ["src/modules/decomiso/application/execute-decomiso.ts", "executeDecomiso"],
    ["src/modules/custody-disputes/application/resolve-dispute.ts", "resolveDisputeUseCase"],
  ])("accepts %s#%s, which ENDS the sponsorship instead of refusing", (relPath, fn) => {
    expect(indexGuardedFunctions(sources).has(`${relPath}#${fn}`)).toBe(true);
    // Passing on its own merits, not by being excused.
    expect(Object.keys(CUSTODY_HANDOFF_ALLOWLIST).some((k) => k === `${relPath}#${fn}`)).toBe(
      false,
    );
  });

  it("has no offender outside the documented allowlist", () => {
    const offenders = findUnguardedHandoffs(sources);
    expect(
      offenders.map((o) => `${o.site.relPath}:${o.site.line} ${o.site.fn} — ${o.problem}`),
    ).toEqual([]);
  });

  // The allowlist is the fence's confession. Every entry must carry a reason
  // long enough to be an argument rather than a shrug, and must still name a
  // site the scan can actually see — an entry pointing at nothing is a silent
  // widening the next time that code moves.
  it("documents every allowlist entry, and every entry still names a real site", () => {
    for (const [key, reason] of Object.entries(CUSTODY_HANDOFF_ALLOWLIST)) {
      expect(key, `${key} must be "<relPath>#<fn>"`).toMatch(/^[\w./[\]()-]+#[\w<>]+$/);
      expect(reason.length, `${key} needs a real reason`).toBeGreaterThan(80);
      const [relPath, fn] = key.split("#");
      expect(
        sites.some((s) => s.relPath === relPath && s.fn === fn && s.direction === "org_to_org"),
        `${key} is allowlisted but the scan no longer finds it — delete the entry or fix the scan`,
      ).toBe(true);
    }
  });

  // Both allowlisted sites are the decomiso chain, and both rest on the same
  // upstream guarantee. Pin that the guarantee is still where the reasons say
  // it is: executeDecomiso discharges the sponsorship before either runs.
  it("keeps the upstream guarantee the allowlist entries rest on", () => {
    const executeDecomiso = sources.find(
      (s) => s.relPath === "src/modules/decomiso/application/execute-decomiso.ts",
    );
    expect(executeDecomiso).toBeDefined();
    expect(executeDecomiso?.src).toContain("endAllLiveOwnerships");
    expect(executeDecomiso?.src).toContain("sponsorshipOutcome");
    expect(Object.keys(CUSTODY_HANDOFF_ALLOWLIST).every((k) => k.includes("/decomiso/"))).toBe(
      true,
    );
  });

  it("still watches both custody-transfer event types", () => {
    expect([...CUSTODY_HANDOFF_EVENT_TYPES].sort()).toEqual([
      "custody_transfer_proposed",
      "custody_transferred",
    ]);
    for (const eventType of CUSTODY_HANDOFF_EVENT_TYPES) {
      expect(sites.some((s) => s.eventType === eventType)).toBe(true);
    }
  });
});
