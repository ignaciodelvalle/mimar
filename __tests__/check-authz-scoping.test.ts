/**
 * Unit tests for scripts/check-authz-scoping.ts.
 *
 * Pure fixture tests — no filesystem I/O. The fence decides "scoped" from the
 * TypeScript AST (A5d): a tenant-guarded action is scoped when a value bound
 * from the guard or the session reaches its work, or when the guard is pinned
 * to the row the action acts on. Words in strings, comments or identifiers that
 * merely spell an authority concept must not count — the old regex fence passed
 * resolvePlaceFromQueueAction only because a revalidatePath string matched
 * /localidad/i.
 */

import { describe, expect, it } from "vitest";

import { GUARD_HOMES } from "@/scripts/check-authz-guards";
import {
  MIN_SCOPED,
  MIN_SUBJECTS,
  TENANT_GUARDS,
  analyzeActions,
  findScopingOffenders,
  ratchet,
  ratchetVerdict,
  scanSurface,
  vacuityViolations,
} from "@/scripts/check-authz-scoping";

const verdict = (src: string) => {
  const [v] = analyzeActions("app/actions/x.ts", src);
  return v;
};
const lines = (...l: string[]) => l.join("\n");

// ---------------------------------------------------------------------------
// Subjects — who has to prove scoping at all
// ---------------------------------------------------------------------------

describe("subjects", () => {
  it("an action calling a tenant guard is a subject", () => {
    const v = verdict(
      lines(
        "export async function a(id: string) {",
        "  await requireAdminOrGovtOrRedirect();",
        "  return w(id);",
        "}",
      ),
    );
    expect(v.subject).toBe(true);
  });

  it("a personal-tier guard alone does not make a subject", () => {
    const v = verdict(
      lines(
        "export async function bookSlotAction(slotId: string, petId: string) {",
        "  const { user } = await requireUserOrRedirect();",
        "  return bookSlotWriter(user.id, slotId, petId);",
        "}",
      ),
    );
    expect(v.subject).toBe(false);
  });

  it("a tenant guard named only in a comment or a string is not a call", () => {
    const v = verdict(
      lines(
        "export async function a(id: string) {",
        "  // requireAdminOrRedirect() runs upstream",
        '  const label = "requireAdminOrRedirect()";',
        "  return w(id, label);",
        "}",
      ),
    );
    expect(v.subject).toBe(false);
  });

  it("inner writers and @no-auth-required exports are not subjects", () => {
    const writer = verdict(
      lines(
        "export async function deactivateGovtForAuthority(actorUserId: string, targetId: string) {",
        "  await requireAdminOrRedirect();",
        "  return _run(targetId);",
        "}",
      ),
    );
    const optedOut = verdict(
      lines(
        "// @no-auth-required: cron writer, CRON_SECRET-gated route",
        "export async function materializeAllActiveSlots() {",
        "  await requireAdminOrRedirect();",
        "  return run();",
        "}",
      ),
    );
    expect(writer.subject).toBe(false);
    expect(optedOut.subject).toBe(false);
  });

  it("only exported async functions are analysed", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        "async function local() { await requireAdminOrRedirect(); }",
        "export function sync() { return 1; }",
        "export async function real() { await requireAdminOrRedirect(); }",
      ),
    );
    expect(vs.map((v) => v.name)).toEqual(["real"]);
  });
});

// ---------------------------------------------------------------------------
// Negative fixtures — words are not authority
// ---------------------------------------------------------------------------

describe("offenders: the old markers in strings, comments and incidental identifiers", () => {
  it("FLAGS an unscoped action whose only marker words sit in a string literal and a comment", () => {
    // Every word the regex fence accepted: localidad, locality, jurisdiction,
    // organizationId, actorUserId, ownerships. — in a comment, in strings, and
    // as the NAME of a caller-supplied field. None of it is bound from the guard.
    const src = lines(
      "export async function resolvePlaceFromQueueAction(input: { actorUserId: string; localityId: string }) {",
      "  // scoped by jurisdiction: localidad, locality, organizationId, actorUserId, ownerships.x",
      "  await requireAdminOrRedirect();",
      "  const result = await resolvePlaceFromQueue(db, input.actorUserId, input);",
      '  revalidatePath("/admin/localidades/pendientes");',
      '  console.log("jurisdiction ownerships.join organizationId !== token");',
      "  return result;",
      "}",
    );
    expect(verdict(src)).toMatchObject({ subject: true, scopedBy: null });
    expect(findScopingOffenders("app/actions/x.ts", src)).toEqual([
      "app/actions/x.ts#resolvePlaceFromQueueAction",
    ]);
  });

  it("FLAGS a guard result that reaches only revalidatePath / redirect / a log line", () => {
    const src = lines(
      "export async function a(id: string) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  await w(id);",
      "  revalidatePath(`/admin/${user.id}`);",
      "  console.info(user.id);",
      "  redirect(`/x/${String(user.id)}`);",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a guard result compared only against a literal (a state check, not a binding)", () => {
    const src = lines(
      "export async function a(id: string) {",
      "  const session = await requireAdminOrGovtOrRedirect();",
      '  if (session.profile.role === "admin") return w(id);',
      "  return null;",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a guard's refusal message copied into a failure row inside a callback", () => {
    const src = lines(
      "export async function a(input: { ids: string[]; orgId: string }) {",
      '  const cap = await requireCapability("x", input.orgId);',
      "  if (cap.error) return input.ids.map((id) => ({ id, reason: cap.error }));",
      "  failed.push(cap.error);",
      "  return w(input.ids);",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a guard value that only lands in a callback's RESULT (data handed back)", () => {
    const src = lines(
      "export async function a(input: { ids: string[] }) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  await w(input.ids);",
      "  return input.ids.map((id) => ({ id, by: user.id }));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a capability pinned to a caller-supplied org whose result is thrown away", () => {
    const src = lines(
      "export async function a(input: { orgId: string; thingId: string }) {",
      '  await requireCapability("x", input.orgId);',
      "  await db.update(things).set({ done: true }).where(eq(things.id, input.thingId));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a guard binding shadowed by a callback parameter of the same name", () => {
    const src = lines(
      "export async function a(input: { users: { id: string }[] }) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  void user;",
      "  return input.users.map((user) => w(user.id));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Positive fixtures — structure that IS scoping
// ---------------------------------------------------------------------------

describe("scoped: authority reaches the work", () => {
  it("passes the resolve-place shape: actor bound from the guard and handed to the writer", () => {
    const src = lines(
      "export async function resolvePlaceFromQueueAction(input: { subjectId: string }) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  const actorUserId = user.id;",
      "  return resolvePlaceFromQueue(db, actorUserId, input);",
      "}",
    );
    expect(verdict(src).scopedBy).toBe("actorUserId → resolvePlaceFromQueue()");
  });

  it("passes a tenant id from an org guard used in a WHERE predicate", () => {
    const src = lines(
      "export async function updateOfferingCapacityAction(orgToken: string, id: string) {",
      "  const { organization } = await requireOrgAccessByToken(orgToken);",
      "  await db.update(serviceOfferings).where(eq(serviceOfferings.organizationId, organization.id));",
      "}",
    );
    expect(verdict(src).scopedBy).toBe("organization → eq()");
  });

  it("passes a whole session handed to a use-case, through a wrapper and a type assertion", () => {
    const src = lines(
      "export async function a(query: string) {",
      "  const raw = await boundSession(requireAdminOrGovtOrRedirect());",
      "  const session = raw as AdminOrGovtSession;",
      "  return searchOmnibox(session, query);",
      "}",
    );
    expect(verdict(src).scopedBy).toBe("session → searchOmnibox()");
  });

  it("passes the inline identity re-check", () => {
    const src = lines(
      "export async function a(input: { receiverOrgToken: string }) {",
      '  const { organization } = await requireCapability("x");',
      "  if (organization.publicToken !== input.receiverOrgToken) notFound();",
      "}",
    );
    expect(verdict(src).scopedBy).toBe("organization → !== comparison");
  });

  it("passes a jurisdiction membership predicate on the session", () => {
    const src = lines(
      "export async function a(pet: { province: string }) {",
      "  const session = await requireAdminOrGovtOrRedirect();",
      "  if (!session.jurisdictions.some((j) => j.province === pet.province)) notFound();",
      "}",
    );
    expect(verdict(src).scopedBy).toBe("session → some()");
  });

  it("passes a guard pinned to the row's own tenant (the resource flows INTO the guard)", () => {
    const src = lines(
      "export async function markNoShowAction(token: string) {",
      "  const [appt] = await db.select().from(appointments).where(eq(appointments.publicToken, token));",
      '  const capResult = await requireCapability("appointment.manage", appt.organizationId);',
      "  if (capResult.error) return { error: capResult.error };",
      "  return markNoShow(appt.id);",
      "}",
    );
    expect(verdict(src).scopedBy).toBe(
      "requireCapability(appt.organizationId) — guard pinned to the row's own tenant",
    );
  });

  it("findScopingOffenders keeps the unscoped sibling and drops the scoped one", () => {
    const src = lines(
      "export async function revokeVetRoleAction(targetUserId: string) {",
      "  await requireAdminOrGovtOrRedirect();",
      "  return revokeVetRoleForAuthority(actor, targetUserId);",
      "}",
      "export async function scopedAction(orgToken: string) {",
      "  const { organization } = await requireOrgAccessByToken(orgToken);",
      "  await db.select().where(eq(t.organizationId, organization.id));",
      "}",
    );
    expect(findScopingOffenders("app/actions/x.ts", src)).toEqual([
      "app/actions/x.ts#revokeVetRoleAction",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Non-vacuity
// ---------------------------------------------------------------------------

describe("non-vacuity", () => {
  it("a scan that finds too few subjects or scoped actions is a violation, not a clean run", () => {
    expect(vacuityViolations({ subjects: 0, scoped: 0 })).toHaveLength(2);
    expect(vacuityViolations({ subjects: MIN_SUBJECTS, scoped: 0 })).toHaveLength(1);
    expect(vacuityViolations({ subjects: MIN_SUBJECTS, scoped: MIN_SCOPED })).toEqual([]);
  });

  it("every tenant guard has a home in GUARD_HOMES, and a dead name is refused", () => {
    expect(vacuityViolations({ subjects: MIN_SUBJECTS, scoped: MIN_SCOPED }, GUARD_HOMES)).toEqual(
      [],
    );
    const withoutAdmin = Object.fromEntries(
      Object.entries(GUARD_HOMES).filter(([name]) => name !== "requireAdminOrRedirect"),
    );
    expect(
      vacuityViolations({ subjects: MIN_SUBJECTS, scoped: MIN_SCOPED }, withoutAdmin).join("\n"),
    ).toMatch(/requireAdminOrRedirect/);
    expect(TENANT_GUARDS.length).toBeGreaterThan(5);
  });

  it("scanSurface counts subjects and scoped actions across files", () => {
    const scan = scanSurface([
      {
        relPath: "a.ts",
        src: lines(
          "export async function s() { const { user } = await requireAdminOrRedirect(); return w(user.id); }",
          "export async function u(id: string) { await requireAdminOrRedirect(); return w(id); }",
          "export async function p() { const { user } = await requireUserOrRedirect(); return w(user.id); }",
        ),
      },
    ]);
    expect(scan.subjects).toBe(2);
    expect(scan.scoped).toBe(1);
    expect([...scan.offenders.entries()]).toEqual([["a.ts#u", "a.ts:2"]]);
  });
});

// ---------------------------------------------------------------------------
// ratchet — identity-keyed, every entry reasoned
// ---------------------------------------------------------------------------

describe("ratchet", () => {
  it("clean when the live offenders are exactly the reasoned baseline", () => {
    const r = ratchet({ "a.ts#x": "delegated to y" }, ["a.ts#x"]);
    expect(ratchetVerdict(r)).toBe("clean");
  });

  it("growth for an offender with no entry", () => {
    const r = ratchet({ "a.ts#x": "delegated" }, ["a.ts#x", "a.ts#y"]);
    expect(r.added).toEqual(["a.ts#y"]);
    expect(ratchetVerdict(r)).toBe("growth");
  });

  it("a fix plus a new offender in the same file is NOT a wash (the per-file count hole)", () => {
    const r = ratchet({ "a.ts#x": "delegated" }, ["a.ts#y"]);
    expect(r.added).toEqual(["a.ts#y"]);
    expect(r.stale).toEqual(["a.ts#x"]);
    expect(ratchetVerdict(r)).toBe("growth");
  });

  it("stale when a baselined export no longer offends (A01-8, per export)", () => {
    const r = ratchet({ "a.ts#x": "delegated", "b.ts#z": "read-only" }, ["b.ts#z"]);
    expect(r.stale).toEqual(["a.ts#x"]);
    expect(ratchetVerdict(r)).toBe("stale");
  });

  it("unreasoned when an entry's reason is empty or still UNREVIEWED", () => {
    const r = ratchet({ "a.ts#x": "  ", "b.ts#y": "UNREVIEWED: write why" }, ["a.ts#x", "b.ts#y"]);
    expect(r.unreasoned).toEqual(["a.ts#x", "b.ts#y"]);
    expect(ratchetVerdict(r)).toBe("unreasoned");
  });
});
