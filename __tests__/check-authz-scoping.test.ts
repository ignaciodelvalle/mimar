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
  type ModuleResolver,
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

  it("FLAGS a guard binding shadowed by a for-of variable or a catch clause", () => {
    const loop = lines(
      "export async function a(rows: { id: string }[]) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  for (const user of rows) await w(user.id);",
      "}",
    );
    const caught = lines(
      "export async function a(id: string) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  try { await w(id); } catch (user) { await report(user); }",
      "}",
    );
    expect(verdict(loop).scopedBy).toBeNull();
    expect(verdict(caught).scopedBy).toBeNull();
  });

  it("FLAGS role checks against constants and role lists (state, not scope)", () => {
    const src = lines(
      "export async function a(id: string) {",
      "  const session = await requireAdminOrGovtOrRedirect();",
      "  if (session.profile.role === ROLES.admin) await w(id);",
      "  if (session.profile.role === ADMIN_ROLE) await w(id);",
      "  if (ADMIN_ROLES.includes(session.profile.role)) await w(id);",
      '  if (session.roles.some((r) => r === "admin")) await w(id);',
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("a row keyed by the SESSION does not pin a guard (the caller's own org, not the resource's)", () => {
    // The session-keyed read itself is still a session value reaching a
    // predicate — the flow rule's documented limit (it trusts any work the
    // session reaches) — so this asserts only that rule (a) does not fire.
    const src = lines(
      "export async function a(input: { thingId: string }) {",
      "  const { user } = await requireUserOrRedirect();",
      "  const [me] = await db.select().from(profiles).where(eq(profiles.id, user.id));",
      '  await requireCapability("x", me.organizationId);',
      "  await db.update(things).set({ done: true }).where(eq(things.id, input.thingId));",
      "}",
    );
    expect(verdict(src).scopedBy).not.toMatch(/pinned/);
  });

  it("a session value handed only to another admission guard is not scoping", () => {
    const src = lines(
      "export async function a(input: { thingId: string }) {",
      "  const session = await requireOrgAccessByToken(input.orgToken);",
      '  await requireCapability("x", session.organization.id);',
      "  await db.update(things).set({ done: true }).where(eq(things.id, input.thingId));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS admission helpers on the caller's own membership (getGrantedCapabilities, isManagerRole)", () => {
    const caps = lines(
      "export async function a(t: string, input: { petId: string }) {",
      "  const { membership } = await requireOrgAccessByToken(t);",
      '  if (!(await getGrantedCapabilities(membership)).has("x")) return { error: "no" };',
      "  await db.update(pets).set({ x: 1 }).where(eq(pets.id, input.petId));",
      "}",
    );
    const manager = lines(
      "export async function a(t: string, input: { petId: string }) {",
      "  const { membership } = await requireOrgAccessByToken(t);",
      '  if (!isManagerRole(membership.role)) return { error: "no" };',
      "  await db.update(pets).set({ x: 1 }).where(eq(pets.id, input.petId));",
      "}",
    );
    expect(verdict(caps)).toMatchObject({ subject: true, scopedBy: null });
    expect(verdict(manager)).toMatchObject({ subject: true, scopedBy: null });
  });

  it("FLAGS a session value that only reaches an error construction or fail()", () => {
    const src = lines(
      "export async function a(input: { petId: string }) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  if (!input.petId) throw new Error(`missing pet for ${user.id}`);",
      "  if (input.petId === 'x') throw new ForbiddenError(user.id);",
      "  if (input.petId === 'y') return fail(user.id);",
      "  await db.update(pets).set({ x: 1 }).where(eq(pets.id, input.petId));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("FLAGS a self-protection check that refuses on a MATCH", () => {
    const src = lines(
      "export async function a(input: { targetUserId: string }) {",
      "  const { user } = await requireAdminOrRedirect();",
      "  if (user.id === input.targetUserId) throw new Error('no self');",
      "  if ((input.targetUserId === user.id)) return { error: 'no self' };",
      "  await db.update(profiles).set({ x: 1 }).where(eq(profiles.id, input.targetUserId));",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("a declaration derived by a constant comparison does not inherit taint", () => {
    const src = lines(
      "export async function a(input: { petId: string }) {",
      "  const session = await requireAdminOrGovtOrRedirect();",
      '  const isAdmin = session.profile.role === "admin";',
      "  const notGovt = !(session.profile.role === ROLES.govt);",
      "  await w(input.petId, isAdmin, notGovt);",
      "}",
    );
    expect(verdict(src).scopedBy).toBeNull();
  });

  it("a destructured `error` from a guard is the refusal channel, not scope", () => {
    const src = lines(
      "export async function a(input: { orgToken: string; petId: string }) {",
      '  const { error } = await requireCapabilityForOrgToken("x", input.orgToken);',
      "  if (error) throw new Error(error);",
      "  setFailure(error);",
      "  await db.update(pets).set({ x: 1 }).where(eq(pets.id, input.petId));",
      "}",
    );
    expect(verdict(src)).toMatchObject({ subject: true, scopedBy: null });
  });

  it("FLAGS a guard pinned to one row while the work touches another by input id", () => {
    const src = lines(
      "export async function a(token: string, input: { otherId: string }) {",
      "  const [appt] = await db.select().from(appointments).where(eq(appointments.publicToken, token));",
      '  const cap = await requireCapability("appointment.manage", appt.organizationId);',
      "  if (cap.error) return { error: cap.error };",
      "  return markNoShow(input.otherId);",
      "}",
    );
    expect(verdict(src)).toMatchObject({ subject: true, scopedBy: null });
  });

  it("analyses an exported async arrow action like a function declaration", () => {
    const src = lines(
      "export const a = async (id: string) => {",
      "  await requireAdminOrRedirect();",
      "  return w(id);",
      "};",
    );
    expect(findScopingOffenders("app/actions/x.ts", src)).toEqual(["app/actions/x.ts#a"]);
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
// Export shapes and import aliases (A13) — every way a client can reach a body
// ---------------------------------------------------------------------------

/** An in-memory module graph: specifier → source. Nothing touches the disk. */
const modules =
  (graph: Record<string, string>): ModuleResolver =>
  (_from, spec) =>
    graph[spec] === undefined ? null : { relPath: spec.replace(/^@\//, ""), src: graph[spec] };
const noModules: ModuleResolver = () => null;

const UNSCOPED_BODY = "{ await requireAdminOrRedirect(); return w(id); }";
const SCOPED_BODY = "{ const { user } = await requireAdminOrRedirect(); return w(user.id, id); }";

describe("export shapes: aliased guard imports", () => {
  it("FLAGS an action whose tenant guard was renamed on import", () => {
    const src = lines(
      'import { requireOrgAccessByToken as guard } from "@/lib/infra/org-access";',
      "export async function a(token: string, id: string) {",
      "  await guard(token);",
      "  return w(id);",
      "}",
    );
    expect(verdict(src)).toMatchObject({ subject: true, scopedBy: null });
    expect(findScopingOffenders("app/actions/x.ts", src, noModules)).toEqual([
      "app/actions/x.ts#a",
    ]);
  });

  it("accepts the renamed guard when its result reaches the work", () => {
    const v = verdict(
      lines(
        'import { requireOrgAccessByToken as guard } from "@/lib/infra/org-access";',
        "export async function a(token: string, id: string) {",
        "  const { organization } = await guard(token);",
        "  return w(organization.id, id);",
        "}",
      ),
    );
    expect(v.subject).toBe(true);
    expect(v.scopedBy).toMatch(/organization → w\(\)/);
  });

  it("a renamed SESSION SOURCE still taints what it binds", () => {
    const v = verdict(
      lines(
        'import { getUser as whoAmI } from "@/lib/infra/auth";',
        "export async function a(id: string) {",
        "  await requireAdminOrRedirect();",
        "  const me = await whoAmI();",
        "  return w(me.id, id);",
        "}",
      ),
    );
    expect(v.scopedBy).toMatch(/^me → w\(\)/);
  });

  it("a LOCAL that shadows the alias is the local, not the guard", () => {
    const [v] = analyzeActions(
      "app/actions/x.ts",
      lines(
        'import { requireAdminOrRedirect as guard } from "@/lib/infra/auth-guards";',
        "export async function a(id: string) {",
        "  const guard = (x: string) => x;",
        "  return w(guard(id));",
        "}",
      ),
      noModules,
    );
    expect(v.subject).toBe(false);
  });
});

describe("export shapes: export { a } / export { a as b } of a local action", () => {
  it("FLAGS a local unscoped action exported by a later export clause, under the EXPORTED name", () => {
    const src = lines(
      `async function a(id: string) ${UNSCOPED_BODY}`,
      "export { a };",
      `async function c(id: string) ${UNSCOPED_BODY}`,
      "export { c as renamed };",
    );
    expect(findScopingOffenders("app/actions/x.ts", src, noModules)).toEqual([
      "app/actions/x.ts#a",
      "app/actions/x.ts#renamed",
    ]);
    // The line is the export clause's: that is where the name is published.
    expect(analyzeActions("app/actions/x.ts", src, noModules).map((v) => v.line)).toEqual([2, 4]);
  });

  it("FLAGS `export const b = a` — an alias is the action it aliases", () => {
    const src = lines(`const a = async (id: string) => ${UNSCOPED_BODY};`, "export const b = a;");
    expect(findScopingOffenders("app/actions/x.ts", src, noModules)).toEqual([
      "app/actions/x.ts#b",
    ]);
  });

  it("follows a cast alias, and FAILS CLOSED on an action wrapped by a call", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        `async function a(id: string) ${UNSCOPED_BODY}`,
        "export const cast = a as typeof a;",
        "export const wrapped = withAuth(a);",
        "export const helper = makeThing(LIMIT);",
      ),
      noModules,
    );
    expect(vs.map((v) => [v.name, v.subject, v.scopedBy, v.unresolved !== undefined])).toEqual([
      ["cast", true, null, false],
      ["wrapped", false, null, true],
    ]);
  });

  it("does not flag a scoped local exported the same ways, nor a non-action export", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        `async function a(id: string) ${SCOPED_BODY}`,
        "function sync() { return 1; }",
        "const LIMIT = 5;",
        "export { a, a as b, sync, LIMIT };",
        "export type { Foo } from './types';",
      ),
      noModules,
    );
    expect(vs.map((v) => [v.name, v.subject, v.scopedBy !== null])).toEqual([
      ["a", true, true],
      ["b", true, true],
    ]);
  });

  it("honours @no-auth-required on the declaration the export clause points at", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        "// @no-auth-required: cron writer, CRON_SECRET-gated route",
        `async function cron(id: string) ${UNSCOPED_BODY}`,
        "export { cron };",
      ),
      noModules,
    );
    expect(vs).toMatchObject([{ name: "cron", subject: false }]);
  });
});

describe("export shapes: default exports, property reads and bound actions", () => {
  it("FLAGS an unscoped `export default async () => {}` under the key `default`", () => {
    const src = `export default async (id: string) => ${UNSCOPED_BODY};`;
    expect(findScopingOffenders("app/actions/x.ts", src, noModules)).toEqual([
      "app/actions/x.ts#default",
    ]);
  });

  it("does not flag a scoped `export default async () => {}`", () => {
    const src = `export default async (id: string) => ${SCOPED_BODY};`;
    expect(analyzeActions("app/actions/x.ts", src, noModules)).toMatchObject([
      { name: "default", subject: true },
    ]);
    expect(findScopingOffenders("app/actions/x.ts", src, noModules)).toEqual([]);
  });

  it("an action read off an object (`export const f = ns.action`) is UNRESOLVED, never silent", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        'import * as ns from "@/lib/actions";',
        "export const f = ns.action;",
        'export const g = actions["approve"];',
      ),
      noModules,
    );
    expect(vs.map((v) => [v.name, v.unresolved !== undefined])).toEqual([
      ["f", true],
      ["g", true],
    ]);
  });

  it("a BOUND action (`export const f = a.bind(null, x)`) is UNRESOLVED; binding a non-action is not an action", () => {
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines(
        `async function a(id: string) ${UNSCOPED_BODY}`,
        "function sync(id: string) { return id; }",
        'export const f = a.bind(null, "x");',
        'export const h = sync.bind(null, "x");',
      ),
      noModules,
    );
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ name: "f" });
    expect(vs[0].unresolved).toMatch(/wraps an action in a\.bind\(\)/);
  });

  it("a nested `function guard() {}` that shadows an imported guard alias is the local, not the guard", () => {
    const shadowed = analyzeActions(
      "app/actions/x.ts",
      lines(
        'import { requireAdminOrRedirect as guard } from "@/lib/infra/auth-guards";',
        "export async function a(id: string) {",
        "  function guard(x: string) { return x; }",
        "  return w(guard(id));",
        "}",
      ),
      noModules,
    );
    expect(shadowed).toMatchObject([{ name: "a", subject: false }]);
    // Positive control: the same alias, not shadowed, IS the guard.
    const real = analyzeActions(
      "app/actions/x.ts",
      lines(
        'import { requireAdminOrRedirect as guard } from "@/lib/infra/auth-guards";',
        "export async function a(id: string) {",
        "  await guard();",
        "  return w(id);",
        "}",
      ),
      noModules,
    );
    expect(real).toMatchObject([{ name: "a", subject: true, scopedBy: null }]);
  });
});

describe("export shapes: re-exports of a body that lives in another module", () => {
  const unscopedLib = `export async function a(id: string) ${UNSCOPED_BODY}`;
  const scopedLib = `export async function a(id: string) ${SCOPED_BODY}`;

  it("FLAGS `export { a } from` an unscanned module, keyed by the scanned file", () => {
    const resolve = modules({ "@/lib/a": unscopedLib });
    expect(
      findScopingOffenders("app/actions/x.ts", 'export { a as act } from "@/lib/a";', resolve),
    ).toEqual(["app/actions/x.ts#act"]);
  });

  it("FLAGS the import-then-export shape and `export *` the same way", () => {
    const resolve = modules({ "@/lib/a": unscopedLib, "./b": 'export { a } from "@/lib/a";' });
    expect(
      findScopingOffenders(
        "app/actions/x.ts",
        lines('import { a } from "@/lib/a";', "export { a };"),
        resolve,
      ),
    ).toEqual(["app/actions/x.ts#a"]);
    // Two hops: x → ./b → @/lib/a.
    expect(findScopingOffenders("app/actions/x.ts", 'export * from "./b";', resolve)).toEqual([
      "app/actions/x.ts#a",
    ]);
  });

  it("does not flag a re-exported action whose body IS scoped, nor a re-exported constant", () => {
    const resolve = modules({
      "@/lib/a": lines(scopedLib, "export const LIMIT = 5;"),
    });
    const vs = analyzeActions(
      "app/actions/x.ts",
      lines('export { a, LIMIT } from "@/lib/a";', 'export * from "@/lib/a";'),
      resolve,
    );
    expect(vs.map((v) => [v.name, v.subject, v.scopedBy !== null, v.unresolved])).toEqual([
      ["a", true, true, undefined],
      ["a", true, true, undefined],
    ]);
  });

  it("a re-export the fence cannot follow is UNRESOLVED and fails the scan — never a silent pass", () => {
    const resolve = modules({ "@/lib/a": scopedLib });
    const scan = scanSurface(
      [
        {
          relPath: "app/actions/x.ts",
          src: lines(
            'export { b } from "@/lib/a";', // the module does not export it
            'export { c } from "some-package";', // packages are not followed
            'import { d } from "@/lib/missing";',
            "export { d };",
          ),
        },
      ],
      resolve,
    );
    expect([...scan.unresolved.keys()]).toEqual([
      "app/actions/x.ts#b",
      "app/actions/x.ts#c",
      "app/actions/x.ts#d",
    ]);
    expect(scan.unresolved.get("app/actions/x.ts#c")).toMatch(/cannot resolve "some-package"/);
    expect(scan.subjects).toBe(0);
  });

  it("a cyclic alias chain ends as unresolved instead of recursing forever", () => {
    const resolve = modules({ "./x": 'export { a } from "./x";' });
    const [v] = analyzeActions("app/actions/x.ts", 'export { a } from "./x";', resolve);
    expect(v.unresolved).toMatch(/deeper than/);
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
