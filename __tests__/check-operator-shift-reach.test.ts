// Tests for the operator-shift REACH fence (scripts/check-operator-shift-reach.ts).
//
// A fence is only worth what its red proof is worth. This file spends most of
// its length on synthetic sources that make the scan FAIL, because a fence that
// has only ever been observed green is indistinguishable from one that cannot
// fail — and the four bypasses this one was written for all sat behind guards
// that check-authz-guards.ts had been calling clean for months.
//
// The real-tree assertions at the end are the other half: they pin that the
// ANTECEDENT still recognises the operator surfaces, because a fence whose
// antecedent quietly narrows to zero reports success forever.

import { describe, expect, it } from "vitest";

import {
  MIN_OPERATOR_RESOLVERS,
  MIN_SCANNED_FILES,
  MIN_SESSION_RESOLUTIONS,
  MIN_SHIFT_REACHERS,
  OPERATOR_SIGNALS,
  SHIFT_REACH_ALLOWLIST,
  type ScanSource,
  countSessionResolvingUnits,
  extractAsyncFunctions,
  findOperatorResolvers,
  findShiftReachOffenders,
  indexShiftReachers,
  listScanSources,
  operatorSignalsIn,
} from "@/scripts/check-operator-shift-reach";

// ---------------------------------------------------------------------------
// Synthetic sources — the red proof
// ---------------------------------------------------------------------------

const src = (relPath: string, body: string): ScanSource => ({ relPath, src: body });

/** The exact shape of the alert-firings bypass: private fn, bare getUser. */
const BARE_ADMIN_GUARD = `
async function requireAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Sesión expirada" };
  const [profile] = await db.select().from(profiles).where(eq(profiles.id, user.id));
  if (profile.role !== "admin") return { error: "no" };
  return { userId: user.id };
}
`;

describe("red proof — a guard detached from the shift is named", () => {
  it("flags a session-resolving function that decides on an operator role", () => {
    const offenders = findShiftReachOffenders([src("app/actions/thing.ts", BARE_ADMIN_GUARD)]);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("app/actions/thing.ts");
    expect(offenders[0]).toContain("requireAdminUser");
    expect(offenders[0]).toContain("8-hour operator shift");
  });

  it("goes quiet the moment the same guard reaches requireLiveUser", () => {
    const fixed = `
async function requireAdminUser() {
  const live = await requireLiveUser();
  if (!live.ok) return { error: live.error };
  if (live.profile?.role !== "admin") return { error: "no" };
  return { userId: live.user.id };
}
`;
    expect(findShiftReachOffenders([src("app/actions/thing.ts", fixed)])).toEqual([]);
  });

  // The whole reason this scan propagates: DIM puts the guard in one layer and
  // the decision two files away, so a rule that demanded both in one body would
  // be a fence that could never go green for the right reason.
  it("accepts a guard reached TWO hops away, through a call chain", () => {
    const sources = [
      src(
        "app/api/x/_guard.ts",
        `
export async function resolveActor() {
  const inner = await resolveLiveThing();
  if (!inner.ok) return inner;
  if (inner.profile.accountType !== "institutional") return { error: "no" };
  return inner;
}
`,
      ),
      src(
        "lib/infra/middle.ts",
        `
export async function resolveLiveThing() {
  return callTheGuard();
}
export async function callTheGuard() {
  return requireLiveUser();
}
`,
      ),
    ];

    expect(findShiftReachOffenders(sources)).toEqual([]);
  });

  it("resolves an import alias, so renaming the guard at the import site cannot hide it", () => {
    const aliased = `
import { requireLiveUser as live } from "@/lib/infra/live-user";
export async function resolveActor() {
  const l = await live();
  if (l.profile.role !== "govt") return null;
  return l;
}
`;
    expect(findShiftReachOffenders([src("app/api/x/_guard.ts", aliased)])).toEqual([]);
  });

  // A guard named in prose is documentation, not a call. Every sibling fence
  // learned this the hard way (check-authz-guards.ts, 2026-08-09).
  it("does not accept a guard named only in a comment", () => {
    const commented = `
export async function resolveActor() {
  // Liveness is handled upstream by requireLiveUser(), honest.
  const { data: { user } } = await supabase.auth.getUser();
  if (user.role !== "admin") return null;
  return user;
}
`;
    const offenders = findShiftReachOffenders([src("app/api/x/_guard.ts", commented)]);
    expect(offenders).toHaveLength(1);
  });
});

describe("what the scan can SEE", () => {
  // Two of the four real bypasses were module-PRIVATE functions. A walker
  // anchored on `^export` — which is what check-authz-guards.ts uses — could not
  // have seen either of them.
  it("reads a non-exported async function", () => {
    const names = extractAsyncFunctions(BARE_ADMIN_GUARD).map((f) => f.name);
    expect(names).toContain("requireAdminUser");
  });

  it("reads the `const x = async (…) => {}` form as well as the declaration", () => {
    const arrow = `
const resolveActor = async (orgToken: string) => {
  const { data: { user } } = await supabase.auth.getUser();
  if (user.accountType !== "institutional") return null;
  return user;
};
`;
    expect(extractAsyncFunctions(arrow).map((f) => f.name)).toEqual(["resolveActor"]);
    expect(findShiftReachOffenders([src("lib/infra/x.ts", arrow)])).toHaveLength(1);
  });

  it("does not treat a helper handed a userId as an actor resolver", () => {
    // No session is resolved here — it is a data read scoped by a parameter.
    // Flagging it would flood the baseline and teach people to ignore the fence.
    const helper = `
export async function loadOrgAdmins(userId: string) {
  return db.select().from(organizationMemberships).where(eq(organizationMemberships.userId, userId));
}
`;
    expect(findShiftReachOffenders([src("lib/infra/x.ts", helper)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The signal table's own non-vacuity
// ---------------------------------------------------------------------------
//
// OPERATOR_SIGNALS is the antecedent. A regex in it that stops matching does
// not make the fence red — it makes the fence NARROWER, silently, which is the
// failure mode with no symptom. So every entry is exercised.

describe("OPERATOR_SIGNALS — every entry still fires", () => {
  const FIXTURES: ReadonlyArray<readonly [string, string]> = [
    ["role comparison", 'if (profile.role !== "admin") return null;'],
    [
      "role comparison, allow-list order",
      'const allow = ["admin", "govt"]\n  if (!allow.includes(profile.role)) return null;',
    ],
    [
      "role comparison, wrapped across lines by the formatter",
      'if (\n  profile.role !== "admin" &&\n  profile.role !== "govt"\n) return null;',
    ],
    ["institutional account type", 'if (profile.accountType !== "institutional") return null;'],
    ["isInstitutionalPrincipal", "if (isInstitutionalPrincipal(profile)) return null;"],
    ["loadActiveInstitutionalProfile", "const p = await loadActiveInstitutionalProfile(id, opts);"],
    ["org membership", "const rows = await getActiveMemberships(userId);"],
    ["capability grants", "const granted = await getGrantedCapabilities(membership);"],
    ["jurisdictions", "const j = await getJurisdictionsCached(profile.id);"],
  ];

  for (const [label, body] of FIXTURES) {
    it(`recognises: ${label}`, () => {
      expect(operatorSignalsIn(body).length).toBeGreaterThan(0);
    });
  }

  it("says nothing about a citizen surface", () => {
    expect(
      operatorSignalsIn("const pet = await db.select().from(pets).where(eq(pets.id, id));"),
    ).toEqual([]);
  });

  it("exercises EVERY signal, not just most of them", () => {
    // Counting fixtures against signals would pass with two fixtures for one
    // entry and none for another. This asserts coverage per entry, so adding a
    // signal without a fixture — a regex nobody ever proved matches anything —
    // fails here rather than narrowing the fence in silence.
    const covered = new Set(FIXTURES.flatMap(([, body]) => operatorSignalsIn(body)));
    const uncovered = OPERATOR_SIGNALS.map((s) => s.why).filter((why) => !covered.has(why));
    expect(uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The session-resolution leg's own non-vacuity
// ---------------------------------------------------------------------------
//
// `resolvesSession` is an OR:
//
//     SESSION_RESOLUTION_RE.test(unit.body) || reaches
//
// and on a clean tree the right-hand side is already true for everything that
// survives the operator-signal filter. So the regex is load-bearing for exactly
// one population — a NEW bare-getUser operator guard, which is the shape of all
// four bypasses this fence exists for — and completely invisible to every other
// number the scan prints. That is what MIN_SESSION_RESOLUTIONS counts.

describe("SESSION_RESOLUTION_RE — the leg no other count can see", () => {
  it("counts a bare getUser, and nothing else", () => {
    const resolving = `
async function resolveActor() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}
`;
    const notResolving = `
async function loadPets(ownerId: string) {
  return db.select().from(pets).where(eq(pets.ownerId, ownerId));
}
`;
    expect(countSessionResolvingUnits([src("lib/infra/x.ts", resolving)])).toBe(1);
    expect(countSessionResolvingUnits([src("lib/infra/x.ts", notResolving)])).toBe(0);
  });

  it("stays blind to a session resolved through a guard — that is the reach credit's job", () => {
    // The regex is DELIBERATELY narrow: every other way of resolving a session
    // here goes through a function the transitive index already credits. This
    // pins that the two legs are separate, which is why one can die silently.
    const viaGuard = `
async function resolveActor() {
  const live = await requireLiveUser();
  return live.ok ? live.user : null;
}
`;
    expect(countSessionResolvingUnits([src("lib/infra/x.ts", viaGuard)])).toBe(0);
    expect(findShiftReachOffenders([src("lib/infra/x.ts", viaGuard)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

// The whole-repo derivations are computed ONCE, in the describe body, and the
// tests only assert over them.
//
// That is not tidiness. Collection runs outside the per-test timeout, and these
// three scan 1,861 files: leaving the work inside an `it` charged one arbitrary
// test for all of it, which is exactly how "clears its three non-vacuity floors"
// timed out at 5s under full-suite contention on 2026-08-25 while passing in
// isolation. A test that fails because of what ANOTHER test left running is a
// test whose red says nothing about its subject. (The scan itself also got
// cheaper in the same commit — see the caches in check-operator-shift-reach.ts —
// but the ordering fix is the one that makes the timing honest.)
describe("the repository itself", () => {
  const sources = listScanSources();
  const offenders = findShiftReachOffenders(sources);
  const resolvers = findOperatorResolvers(sources);
  const reaching = indexShiftReachers(sources);
  const sessionResolutions = countSessionResolvingUnits(sources);

  it("has no operator-actor resolver that skips the shift", () => {
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist empty", () => {
    // It was born empty because the four offenders this fence was written for
    // were FIXED in the same batch rather than baselined. An entry appearing
    // here is a decision, and it needs a reason next to it.
    expect(Object.keys(SHIFT_REACH_ALLOWLIST)).toEqual([]);
  });

  it("clears its four non-vacuity floors", () => {
    expect(sources.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
    expect(reaching.size).toBeGreaterThanOrEqual(MIN_SHIFT_REACHERS);
    expect(resolvers.length).toBeGreaterThanOrEqual(MIN_OPERATOR_RESOLVERS);
    expect(sessionResolutions).toBeGreaterThanOrEqual(MIN_SESSION_RESOLUTIONS);
  });

  // WHY THE FOURTH FLOOR HAD TO EXIST, stated as a measurement rather than as
  // an argument. Every operator-actor resolver in the tree reaches the shift —
  // that is what a green fence means — so `reaches` alone satisfies
  // `resolvesSession` for all of them and the regex leg decides NOTHING here.
  // Kill SESSION_RESOLUTION_RE and this list does not move, the offender list
  // does not move, and the green line does not move. Only MIN_SESSION_RESOLUTIONS
  // notices.
  it("proves the regex leg contributes zero to the resolver list today", () => {
    expect(resolvers.filter((r) => !r.reaches)).toEqual([]);
  });

  // THE ANTECEDENT ITSELF, pinned by name. If the scan stops recognising these
  // as operator-actor resolvers it stops guarding them, and it would report
  // that as a clean run.
  it("still recognises the guards this fence exists for", () => {
    const found = new Set(resolvers.map((r) => `${r.relPath}#${r.name}`));

    expect(found).toContain("app/actions/alert-firings.ts#requireAdminUser");
    expect(found).toContain("app/api/gob/_guard.ts#resolveInstitutionalGobActor");
    expect(found).toContain("app/api/panorama/_guard.ts#resolveInstitutionalPanoramaActor");
    expect(found).toContain(
      "src/modules/organizations/infrastructure/authz-resolver.ts#resolveLiveOrgActor",
    );
    expect(found).toContain("lib/infra/auth-guards.ts#requireAdminOrGovtOrRedirect");
  });

  // ATENDER IS DELIBERATELY NOT IN THAT LIST, and the reason is worth writing
  // down so nobody "fixes" it later. After the 2026-08-25 change,
  // resolveAtenderContext carries no operator SIGNAL of its own: it delegates
  // the membership and capability reads to resolveLiveOrgActor and keeps only a
  // `granted.has("event.write")` test. It is not an antecedent because it no
  // longer makes the decision.
  //
  // What the fence guards there is the REGRESSION: put the capability read back
  // in that file and the signal fires immediately. This test is that claim,
  // stated as an experiment rather than as an assurance.
  it("catches the atender bypass the moment its shape returns", () => {
    const regressed = `
export async function resolveAtenderContext(orgToken: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sesión expirada." };
  const granted = await getGrantedCapabilities({ id: membershipRow.membershipId, role: membershipRow.membershipRole });
  if (!granted.has("event.write")) return { ok: false, error: "no" };
  return { ok: true, user };
}
`;
    const offenders = findShiftReachOffenders([
      src("app/org/[orgToken]/atender/atender-access.ts", regressed),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("resolveAtenderContext");
    expect(offenders[0]).toContain("org capability grants");
  });
});
