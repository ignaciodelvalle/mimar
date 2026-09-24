// The PPP attestation evidence rule has TWO copies. This proves they agree.
// T4-I1 / issue #753.
//
// WHY TWO COPIES AT ALL
// ---------------------------------------------------------------------------
// `attestationCountsAsCompliant` (lib/domain/ppp-attestation.ts) decides one
// event at a time, for the owner's compliance card. `/gob`'s C7 metric decides
// the same question over the whole PPP population and cannot call a TS
// predicate per pet, so lib/analytics/compliance-metrics.ts carries the rule
// again as a SQL fragment. Two copies of a rule is a promise to keep them
// equal, and an unkept version of that promise is the worst possible outcome
// here: the owner's card would say "Declarada · no cuenta" while the
// authority's dashboard counted that same animal as compliant. Two maps, one
// territory, quietly disagreeing.
//
// WHAT THIS TEST DOES, AND WHY IT TOUCHES NO TABLE
// ---------------------------------------------------------------------------
// The fixtures go into a VALUES list aliased `pe`, which is exactly the alias
// the fragment's column references assume inside the real `EXISTS (SELECT 1
// FROM pet_events pe ...)`. So the fragment under test is the SHIPPED string,
// not a paraphrase of it, and the test still writes nothing, seeds nothing and
// cannot be poisoned by another run's rows. A version that inserted pets and
// events would be slower, order-dependent, and would prove the same thing.
//
// THE COPIES ARE ALLOWED NO DIFFERENCE AT ALL, and the fixtures below are
// chosen to make that claim expensive to satisfy by accident: every role the
// confidence model treats specially (owner, govt, shelter, vet), each one both
// verified and not, crossed with a number present, absent, null and
// whitespace-only. An early draft of the SQL fragment omitted the vet arm on
// the theory that a vet signs clinical acts and has no standing in an
// administrative inscription. This test is what made that a decision rather
// than an oversight: the two copies disagreed on one row and the fragment
// gained the arm, because `attestationIsInstitutional` reads the SHARED
// confidence model and a local re-derivation of "which tiers count" is exactly
// how the PPP card and the rabies card drift into meaning different things by
// the word "verificada".

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { analyticsDb } from "@/db";
import { PPP_ATTESTED_EVIDENCE } from "@/lib/analytics/compliance-metrics";
import { attestationCountsAsCompliant } from "@/lib/domain/ppp-attestation";

type Fixture = {
  what: string;
  authorRole: string;
  authorVerified: boolean;
  authorOrganizationId: string | null;
  payload: Record<string, unknown>;
};

const FIXTURES: Fixture[] = [
  {
    what: "owner citing the inscription number",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "RUPPPA-12345" },
  },
  {
    what: "owner with registry_id null",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: null },
  },
  {
    what: "owner with no registry_id key at all",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "prov_14107" },
  },
  {
    what: "owner with a registry_id of spaces only",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "   " },
  },
  // THE THREE THE FIRST FIXTURE SET COULD NOT SEE. `btrim(x)` with no second
  // argument strips SPACES ONLY, so the row above passed on both sides by luck
  // while a TAB counted as evidence in SQL and not in TS — the divergence a
  // security review measured. One ASCII, one Latin-1 and one from the Zs block,
  // because the fix is a character CLASS and a class is the kind of thing that
  // is right for the first member and wrong for the fourth.
  {
    what: "owner with a registry_id of a tab",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "\t" },
  },
  {
    what: "owner with a registry_id of a non-breaking space",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "\u00a0" },
  },
  {
    what: "owner with a registry_id of newline and ideographic space",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "\n\u3000" },
  },
  // THE OTHER DIRECTION, so the class cannot be widened into uselessness: a
  // real number wearing that padding is still a real number, and a zero-width
  // space is NOT whitespace to either side, so it stays evidence.
  {
    what: "owner citing a number padded with tabs and a non-breaking space",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "\t RUPPPA-9 \u00a0" },
  },
  {
    what: "owner with a registry_id of a zero-width space",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: "\u200b" },
  },
  {
    what: "verified govt actor, no number",
    authorRole: "govt",
    authorVerified: true,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: null },
  },
  {
    what: "unverified govt actor, no number",
    authorRole: "govt",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: null },
  },
  {
    what: "verified shelter acting for an org, no number",
    authorRole: "shelter",
    authorVerified: true,
    authorOrganizationId: "org-1",
    payload: { registry: "caba_4078", registry_id: null },
  },
  {
    what: "org member without a matrícula, no number",
    authorRole: "shelter",
    authorVerified: false,
    authorOrganizationId: "org-1",
    payload: { registry: "caba_4078", registry_id: null },
  },
  // THE TWO ROWS A REVIEW FOUND THE COPIES DISAGREEING ON, kept as fixtures
  // rather than as a memory of a bug. Both are unreachable through the two
  // product writers and entirely reachable by the population C7 actually
  // measures — hand INSERTs, seeds, a future registry-federation import —
  // which is the same population issue #759 exists because of.
  {
    // `->>` stringifies any JSON scalar, so the SQL said TRUE for this while
    // `typeof raw === "string"` said FALSE. The SQL now checks jsonb_typeof.
    what: "registry_id as a JSON number, not a string",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: 12345 },
  },
  {
    // `computeConfidence`'s A4 bumper returned institutional_verified for ANY
    // author carrying this key, so the TS said TRUE while the SQL said FALSE.
    // A lab confirms a DISEASE, never a registry inscription — the TS side now
    // withholds the payload from the model.
    what: "owner payload carrying a stray confirmed_by_lab",
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    payload: { registry: "caba_4078", registry_id: null, confirmed_by_lab: true },
  },
  {
    what: "verified vet citing the number — both arms agree via (a)",
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: "org-1",
    payload: { registry: "caba_4078", registry_id: "RUPPPA-777" },
  },
  {
    what: "verified vet with NO number — institutional via arm (b)",
    authorRole: "vet",
    authorVerified: true,
    authorOrganizationId: "org-1",
    payload: { registry: "caba_4078", registry_id: null },
  },
];

async function sqlVerdicts(): Promise<boolean[]> {
  const rows = FIXTURES.map(
    (f, i) =>
      sql`(${i}::int, ${JSON.stringify(f.payload)}::jsonb, ${f.authorRole}::text, ${f.authorVerified}::boolean, ${f.authorOrganizationId}::text)`,
  );
  const result = await analyticsDb.execute(sql`
    SELECT i, ${PPP_ATTESTED_EVIDENCE} AS counts
    FROM (VALUES ${sql.join(rows, sql`, `)})
      AS pe(i, payload, author_role, author_verified, author_organization_id)
    ORDER BY i
  `);
  const out = (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? result;
  return (out as Record<string, unknown>[]).map((r) => r.counts === true);
}

describe("PPP attestation evidence — the TS rule and the SQL mirror agree", () => {
  it("returns one verdict per fixture (non-vacuity: the query ran)", async () => {
    const verdicts = await sqlVerdicts();
    expect(verdicts).toHaveLength(FIXTURES.length);
    // Both answers must appear, or an all-true / all-false bug would pass the
    // agreement assertion below by accident.
    expect(new Set(verdicts).size).toBe(2);
  });

  it("agrees on every fixture", async () => {
    const verdicts = await sqlVerdicts();
    // Collected and asserted ONCE rather than an expect per row: a failure
    // should name every fixture that drifted, not just the first, because the
    // shape of the disagreement is what tells you which copy moved.
    const disagreements: string[] = [];
    FIXTURES.forEach((f, i) => {
      const ts = attestationCountsAsCompliant({
        authorRole: f.authorRole,
        authorVerified: f.authorVerified,
        authorOrganizationId: f.authorOrganizationId,
        payload: f.payload,
      });
      if (ts !== verdicts[i]) disagreements.push(`${f.what}: TS=${ts} SQL=${verdicts[i]}`);
    });
    expect(disagreements).toEqual([]);
  });

  it("the shared verdicts are the ones the card would show", async () => {
    // Anchors the table to concrete expectations, so a change that flips BOTH
    // copies the same way still has to argue with something.
    const verdicts = await sqlVerdicts();
    const byWhat = new Map(FIXTURES.map((f, i) => [f.what, verdicts[i]]));
    expect(byWhat.get("owner citing the inscription number")).toBe(true);
    expect(byWhat.get("owner with registry_id null")).toBe(false);
    expect(byWhat.get("owner with no registry_id key at all")).toBe(false);
    expect(byWhat.get("owner with a registry_id of spaces only")).toBe(false);
    expect(byWhat.get("owner with a registry_id of a tab")).toBe(false);
    expect(byWhat.get("owner with a registry_id of a non-breaking space")).toBe(false);
    expect(byWhat.get("owner with a registry_id of newline and ideographic space")).toBe(false);
    expect(byWhat.get("owner citing a number padded with tabs and a non-breaking space")).toBe(
      true,
    );
    // Not whitespace to EITHER side — a trim that swallowed it would be wrong.
    expect(byWhat.get("owner with a registry_id of a zero-width space")).toBe(true);
    expect(byWhat.get("verified govt actor, no number")).toBe(true);
    expect(byWhat.get("unverified govt actor, no number")).toBe(false);
    expect(byWhat.get("verified shelter acting for an org, no number")).toBe(true);
    expect(byWhat.get("org member without a matrícula, no number")).toBe(false);
    expect(byWhat.get("registry_id as a JSON number, not a string")).toBe(false);
    expect(byWhat.get("owner payload carrying a stray confirmed_by_lab")).toBe(false);
  });
});
