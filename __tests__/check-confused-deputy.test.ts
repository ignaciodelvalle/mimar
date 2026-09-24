/**
 * Unit tests for scripts/check-confused-deputy.ts helpers.
 *
 * Pure fixture tests — no filesystem I/O. Exercises the "org-token confused
 * deputy" heuristic against known-bad and known-good inline source strings
 * modelled on the real transfers / service-offerings / schedule-rules actions.
 */

import { describe, expect, it } from "vitest";

import { extractExportedAsyncFunctions } from "@/scripts/check-authz-guards";
import {
  BARE_REQUIRE_CAPABILITY_RE,
  CONFUSED_DEPUTY_ALLOWLIST,
  callsBareRequireCapability,
  callsRequireCapabilityForOrgToken,
  findConfusedDeputyOffenders,
  hasOrgTokenParam,
  isConfusedDeputyOffender,
  readsOrgTokenFromFormData,
  signatureParamList,
} from "@/scripts/check-confused-deputy";

const only = (src: string) => extractExportedAsyncFunctions(src)[0];

// ---------------------------------------------------------------------------
// BARE_REQUIRE_CAPABILITY_RE — single-arg vs two-arg (pinned) form
// ---------------------------------------------------------------------------

describe("BARE_REQUIRE_CAPABILITY_RE", () => {
  it("matches the bare single-argument form", () => {
    expect(BARE_REQUIRE_CAPABILITY_RE.test('requireCapability("custody.transfer")')).toBe(true);
    expect(BARE_REQUIRE_CAPABILITY_RE.test("requireCapability('bite.report')")).toBe(true);
  });

  it("does NOT match the two-argument (org-pinned) form", () => {
    expect(
      BARE_REQUIRE_CAPABILITY_RE.test('requireCapability("member.invite", input.organizationId)'),
    ).toBe(false);
    expect(
      BARE_REQUIRE_CAPABILITY_RE.test('requireCapability("org.transfer.accept", receiverOrg.id)'),
    ).toBe(false);
  });

  it("does NOT match requireCapabilityForOrgToken", () => {
    expect(
      BARE_REQUIRE_CAPABILITY_RE.test('requireCapabilityForOrgToken("custody.transfer", orgToken)'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// signatureParamList / hasOrgTokenParam
// ---------------------------------------------------------------------------

describe("signatureParamList + hasOrgTokenParam", () => {
  it("extracts a positional param list and detects an org token param", () => {
    const src = [
      "export async function transferCustodyAction(",
      "  orgToken: string,",
      "  publicToken: string,",
      "  _previous: TransferCustodyFormState,",
      "  formData: FormData,",
      "): Promise<TransferCustodyFormState> {",
      "  return run();",
      "}",
    ].join("\n");
    const params = signatureParamList(only(src).body);
    expect(params).toContain("orgToken");
    expect(hasOrgTokenParam(params)).toBe(true);
  });

  it("detects a token nested inside a destructured object param", () => {
    const src = [
      "export async function acceptCrossOrgTransferAction(input: {",
      "  receiverOrgToken: string;",
      "  casePublicCode: string;",
      "}): Promise<CrossOrgTransferResult> { return run(); }",
    ].join("\n");
    expect(hasOrgTokenParam(signatureParamList(only(src).body))).toBe(true);
  });

  it("does NOT treat publicToken (the PET token) as an org token", () => {
    const src = [
      "export async function setListingAction(input: { petPublicToken: string }) {",
      "  return run();",
      "}",
    ].join("\n");
    expect(hasOrgTokenParam(signatureParamList(only(src).body))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isConfusedDeputyOffender — the full heuristic
// ---------------------------------------------------------------------------

describe("isConfusedDeputyOffender", () => {
  it("FLAGS the R11 pre-fix form (orgToken param + bare requireCapability)", () => {
    const src = [
      "export async function transferCustodyAction(orgToken: string, publicToken: string) {",
      '  const auth = await requireCapability("custody.transfer");',
      "  if (auth.error !== null) return { error: auth.error };",
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(true);
  });

  it("does NOT flag the R11 post-fix form (requireCapabilityForOrgToken)", () => {
    const src = [
      "export async function transferCustodyAction(orgToken: string, publicToken: string) {",
      '  const auth = await requireCapabilityForOrgToken("custody.transfer", orgToken);',
      "  if (auth.error !== null) return { error: auth.error };",
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  it("does NOT flag a two-argument (org-pinned) requireCapability", () => {
    // decomiso pattern: resolve the org from the token first, pin the check to it.
    const src = [
      "export async function acceptDecomisoAction(input: { receiverOrgToken: string }) {",
      "  const receiverOrg = await findOrgByToken(input.receiverOrgToken);",
      '  const auth = await requireCapability("org.transfer.accept", receiverOrg.id);',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  // KNOWN BLIND SPOT — not a safe pattern, a limit of the heuristic.
  //
  // The check can only flag an action that RECEIVES an org token and then fails
  // to pin to it. An action that never takes one is invisible here, so this
  // returning false says nothing about whether the action is correct — only
  // that this static check cannot see it.
  //
  // This case used to be written with setAdoptionEligibilityAction as its
  // example, under the comment "adoption pattern: session-default org, scoped by
  // petPublicToken in the use-case". That justification was itself the bug:
  // findShelterPet(petPublicToken, organizationId) still needs the RIGHT
  // organizationId, and a pet token cannot disambiguate among a multi-org
  // member's orgs. 21-authz-scoping-audit.md:9 had already filed the missing pin
  // as MED; instead of the pin landing, the shape got enshrined here as
  // acceptable. QA ronda 6 (2026-07-16) then hit it for real: the eligibility
  // write resolved a different org than the URL, and a shelter could not put its
  // own pet up for adoption. The action now takes an orgToken and pins to it, so
  // it is covered by the heuristic above — this example is deliberately
  // synthetic and must never name a real action again.
  it("cannot see a bare requireCapability when the action takes no org token", () => {
    const src = [
      "export async function someAction(input: { petPublicToken: string }) {",
      '  const auth = await requireCapability("intake.create");',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  // R3 (2026-08-09) — the SECOND lane. The heuristic used to read only the
  // typed signature, so an org token arriving through FormData was invisible;
  // this file's header called that a KNOWN BLIND SPOT and named the three
  // actions it covered for. It stopped being latent when a service published
  // from a clinic's panel was written to a sanitary authority the same admin
  // also belongs to.
  it("FLAGS an action that reads orgToken from FormData and still gates bare (R3 pre-fix)", () => {
    const src = [
      "export async function createServiceOfferingAction(_prev: State, formData: FormData) {",
      '  const auth = await requireCapability("service_offering.create");',
      '  const orgToken = String(formData.get("orgToken") ?? "").trim();',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(true);
  });

  it("does NOT flag the R3 post-fix form (FormData token, pinned check)", () => {
    const src = [
      "export async function createServiceOfferingAction(_prev: State, formData: FormData) {",
      '  const orgToken = String(formData.get("orgToken") ?? "").trim();',
      '  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  it("does NOT flag a FormData read of some OTHER field", () => {
    const src = [
      "export async function someAction(_prev: State, formData: FormData) {",
      '  const ruleId = String(formData.get("ruleId") ?? "").trim();',
      '  const auth = await requireCapability("service_offering.create");',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  it("does NOT flag a two-arg call whose docstring mentions the bare form (chip-match pattern)", () => {
    // Regression: the fix comment literally writes requireCapability("intake.create")
    // to explain why it pins the check. Comment text must not count as a call.
    const src = [
      "export async function confirmChipMatchAction(input: { orgToken: string }) {",
      '  // requireCapability("intake.create") alone resolves the session default — so',
      "  // we resolve the org from the token and pin the check to it.",
      "  const orgAccess = await requireOrgAccessByToken(input.orgToken);",
      '  const auth = await requireCapability("intake.create", orgAccess.organization.id);',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });

  it("does NOT flag an inner writer (guarded upstream)", () => {
    const src = [
      "export async function transferCustodyForOrg(orgToken: string, actorUserId: string) {",
      '  const auth = await requireCapability("custody.transfer");',
      "  return run();",
      "}",
    ].join("\n");
    expect(isConfusedDeputyOffender(only(src))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findConfusedDeputyOffenders — located lines + allowlist
// ---------------------------------------------------------------------------

describe("findConfusedDeputyOffenders", () => {
  it("returns a located line for each offender and skips pinned siblings", () => {
    const src = [
      "export async function badAction(orgToken: string) {",
      '  const auth = await requireCapability("service_offering.create");',
      "  return run();",
      "}",
      "export async function goodAction(orgToken: string) {",
      '  const auth = await requireCapabilityForOrgToken("service_offering.create", orgToken);',
      "  return run();",
      "}",
    ].join("\n");
    const offenders = findConfusedDeputyOffenders("app/actions/x.ts", src);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("badAction");
    expect(offenders[0]).toMatch(/app\/actions\/x\.ts:1/);
  });

  it("excludes an allowlisted offender", () => {
    // The allowlist is EMPTY at HEAD (2026-08-22 — its last entry, the org bite
    // report, turned out to be a real CRITICAL). This used to read
    // `Object.keys(CONFUSED_DEPUTY_ALLOWLIST)[0]`, so emptying the list would
    // have silently stopped testing the exclusion mechanism while staying
    // green. A synthetic allowlist keeps the mechanism pinned whether or not
    // anything is actually exempt.
    const relPath = "app/actions/allowlisted.ts";
    const name = "allowlistedAction";
    const src = [
      `export async function ${name}(orgToken: string) {`,
      '  const auth = await requireCapability("bite.report");',
      "  return run();",
      "}",
    ].join("\n");
    // Sanity: it IS an offender shape…
    expect(isConfusedDeputyOffender(only(src))).toBe(true);
    // …and WITHOUT an entry it is reported (the control — without this the
    // assertion below would pass against a function that reports nothing).
    expect(findConfusedDeputyOffenders(relPath, src, {})).toHaveLength(1);
    // …but the allowlist entry keeps it out of the reported set.
    expect(
      findConfusedDeputyOffenders(relPath, src, { [`${relPath}#${name}`]: "documented reason" }),
    ).toHaveLength(0);
  });

  it("ships with an EMPTY allowlist — every exemption is a hypothesis about impact", () => {
    // Not decoration: the entry that lived here argued the worst case was "a
    // report attributed to the wrong org", and the worst case was actually a
    // forced rabies observation on a stranger's animal. If a future entry is
    // added, this line is where somebody has to look the exemption in the eye.
    expect(Object.keys(CONFUSED_DEPUTY_ALLOWLIST)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard helper smoke tests
// ---------------------------------------------------------------------------

describe("guard helpers", () => {
  it("readsOrgTokenFromFormData matches only an org-token field", () => {
    expect(readsOrgTokenFromFormData('formData.get("orgToken")')).toBe(true);
    expect(readsOrgTokenFromFormData("formData.get('senderOrgToken')")).toBe(true);
    expect(readsOrgTokenFromFormData('formData.get( "receiverOrgToken" )')).toBe(true);
    expect(readsOrgTokenFromFormData('formData.get("ruleId")')).toBe(false);
    // publicToken is the PET token in this codebase — never an org scope.
    expect(readsOrgTokenFromFormData('formData.get("publicToken")')).toBe(false);
  });

  it("callsBareRequireCapability / callsRequireCapabilityForOrgToken discriminate", () => {
    expect(callsBareRequireCapability('await requireCapability("x")')).toBe(true);
    expect(callsRequireCapabilityForOrgToken('await requireCapabilityForOrgToken("x", t)')).toBe(
      true,
    );
    expect(callsRequireCapabilityForOrgToken('await requireCapability("x")')).toBe(false);
  });
});
