// Fence: administrative authority is asked of the one authority module
// (jurisdiction-admin Phase 7, scripts/check-admin-authority.ts). The detector
// is pinned on fixtures — a green control and a red control per rule — and its
// verdict over the repository must be clean (what `pnpm lint:admin-authority`
// prints). The action-guard inventory that used to be read from source by the
// Phase-6 portal test lives in the fence now (rule 4).

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  ACTION_GUARD_INVENTORY,
  MIN_ACTOR_WRITERS,
  MIN_GOB_AUDIT_READERS,
  type SourceFile,
  WRAPPERS,
  countAuditReads,
  countRawAdminChecks,
  evaluate,
  readSources,
  takesActor,
} from "../scripts/check-admin-authority";

const APP = "src/modules/organizations/application";
const REPO = readSources();

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
}

function firstFunction(source: string): ts.FunctionDeclaration {
  const fn = parse(source).statements.find(ts.isFunctionDeclaration);
  if (!fn) throw new Error("fixture has no function");
  return fn;
}

/** The repository with `file` replaced (or added) — a red control on real code. */
function withFile(file: string, source: string): SourceFile[] {
  return [...REPO.filter((f) => f.file !== file), { file, source }];
}

function sourceOf(file: string): string {
  const found = REPO.find((f) => f.file === file);
  if (!found) throw new Error(`not in repo: ${file}`);
  return found.source;
}

function rulesOf(files: readonly SourceFile[]): string[] {
  return evaluate(files).violations.map((v) => `${v.rule} ${v.where}`);
}

describe("the detector", () => {
  it("sees an actor as a parameter, a destructured field, or a field read off a parameter", () => {
    expect(takesActor(firstFunction("export async function a(actorUserId: string) {}"))).toBe(true);
    expect(takesActor(firstFunction("export async function a({ actorUserId }: P) {}"))).toBe(true);
    expect(
      takesActor(firstFunction("export async function a(params: P) { use(params.actorUserId); }")),
    ).toBe(true);
    expect(
      takesActor(firstFunction("export async function a(viewerId: string) { use(viewerId); }")),
    ).toBe(false);
    // A string that happens to spell the name is not an actor.
    expect(
      takesActor(firstFunction('export async function a(id: string) { q(`as "actorUserId"`); }')),
    ).toBe(false);
  });

  it("counts hand-written admin-role comparisons in code and SQL, never in a comment", () => {
    const src = [
      '// role === "admin" used to be asked here; see authority.ts',
      "/* eq(profiles.role, 'admin') */",
      'if (p.role === "admin") {}',
      'if ("admin" !== actor?.role) {}',
      'where(eq(profiles.role, "admin"));',
      "sql`select 1 from profiles where role = 'admin'`;",
      'const roles = z.enum(["govt", "admin"]);',
    ].join("\n");
    expect(countRawAdminChecks(parse(src))).toBe(4);
  });

  it("counts audit_log reads in code and SQL, never in a comment", () => {
    const src = [
      "// db.select().from(auditLog) is how the old page read it",
      "db.select().from(auditLog).where(x);",
      "sql`select id from public.audit_log where x`;",
      "db.select().from(auditLogArchive);",
    ].join("\n");
    expect(countAuditReads(parse(src))).toBe(2);
  });
});

describe("the repository", () => {
  it("is clean, above both floors", () => {
    const report = evaluate(REPO);
    expect(report.violations).toEqual([]);
    expect(report.actorWriters.length).toBeGreaterThanOrEqual(MIN_ACTOR_WRITERS);
    expect(report.gobAuditReaders).toBeGreaterThanOrEqual(MIN_GOB_AUDIT_READERS);
  });

  it("sees every writer the design names, the platform-only reversal included", () => {
    const { actorWriters } = evaluate(REPO);
    for (const key of [
      `${APP}/admin-authority/appoint.ts#appointJurisdictionAdmin`,
      `${APP}/admin-authority/revoke.ts#revokeJurisdictionAdmin`,
      `${APP}/admin-institutional/create-institutional-account.ts#createInstitutionalAccountForAuthority`,
      `${APP}/admin-institutional/deactivate-govt.ts#deactivateGovtForAuthority`,
      `${APP}/admin-institutional/reactivate-govt.ts#reactivateGovtForAuthority`,
      `${APP}/admin-institutional/assign-govt-locality.ts#assignGovtLocalityForAuthority`,
      `${APP}/authority-units/grant-unit.ts#confirmGrantUnit`,
      `${APP}/authority-units/manage-units.ts#moveLocalityToUnit`,
      `${APP}/business-rules/update-business-rule.ts#updateBusinessRuleWriter`,
      "lib/place/unresolved-queue.ts#resolvePlaceFromQueue",
    ]) {
      expect(actorWriters, key).toContain(key);
    }
  });
});

// Red controls: each rule, on a copy of the REAL file with one thing removed.
describe("red controls", () => {
  it("rule 1 — a new writer that takes an actor and asks nothing", () => {
    const file = `${APP}/authority-units/new-writer.ts`;
    const files = withFile(
      file,
      "export async function doIt(tx: Tx, actorUserId: string) { await tx.update(x); }",
    );
    expect(rulesOf(files)).toContain(`writer-guard ${file}#doIt`);
  });

  it("rule 1 — hasAdminAuthority alone is not a guard", () => {
    const file = `${APP}/authority-units/new-writer.ts`;
    const files = withFile(
      file,
      "export async function doIt(tx: Tx, actorUserId: string) { if (!(await hasAdminAuthority(tx, actorUserId))) return; }",
    );
    expect(rulesOf(files)).toContain(`writer-guard ${file}#doIt`);
  });

  it("rule 1 — the reactivation writer without requirePlatformAdmin", () => {
    const file = `${APP}/admin-institutional/reactivate-govt.ts`;
    const src = sourceOf(file).replace(
      "!(await requirePlatformAdmin(tx, actorUserId))",
      "!(await hasAdminAuthority(tx, actorUserId))",
    );
    expect(rulesOf(withFile(file, src))).toContain(
      `writer-guard ${file}#reactivateGovtForAuthority`,
    );
  });

  it("rule 1 — a wrapper that stops asking a base guard takes its writers down with it", () => {
    const file = WRAPPERS.ruleWriteRefusal;
    const src = sourceOf(file).replace(
      "if (await requireJurisdictionAdminFor(exec, actorUserId, provinces)) return null;",
      "if (provinces.length > 0) return null;",
    );
    const rules = rulesOf(withFile(file, src));
    expect(rules).toContain(`writer-guard ${file}#ruleWriteRefusal`);
    expect(rules).toContain(
      `writer-guard ${APP}/business-rules/create-business-rule.ts#createBusinessRuleWriter`,
    );
  });

  it("rule 1 — a stale exemption is an error", () => {
    const file = `${APP}/admin-institutional/helpers.ts`;
    const src = sourceOf(file).replace("loadActorProfile(", "loadActorProfileRenamed(");
    expect(rulesOf(withFile(file, src))).toContain(`writer-guard ${file}#loadActorProfile`);
  });

  it("rule 2 — a local isActiveAdmin anywhere, and a raw admin-role check in a writer folder", () => {
    const helper = "lib/infra/new-helper.ts";
    const writer = `${APP}/authority-units/new-writer.ts`;
    const files = [
      ...withFile(helper, "export function isActiveAdmin(p: P) { return true; }"),
      {
        file: writer,
        source:
          'export async function x(tx: Tx, actorUserId: string) { await requirePlatformAdmin(tx, actorUserId); if (p.role === "admin") {} }',
      },
    ];
    const rules = rulesOf(files);
    expect(rules).toContain(`no-local-admin-check ${helper}#isActiveAdmin`);
    expect(rules).toContain(`no-local-admin-check ${writer}`);
  });

  it("rule 2 — a frozen count that moved is an error", () => {
    const file = `${APP}/admin-institutional/deactivate-admin.ts`;
    const src = sourceOf(file).replace("AND role = 'admin'", "AND is_admin");
    expect(rulesOf(withFile(file, src))).toContain(`no-local-admin-check ${file}`);
  });

  it("rule 3 — the history page without the redaction, and a new unscoped /gob reader", () => {
    const page = "app/gob/historial/page.tsx";
    const src = sourceOf(page).replace(
      "const projected = auditHistoryRowColumns(scope);",
      "const projected = rawColumns(scope);",
    );
    const reader = "app/gob/nuevo/page.tsx";
    const files = [
      ...withFile(page, src),
      {
        file: reader,
        source: "export default async function P() { await db.select().from(auditLog); }",
      },
    ];
    const rules = rulesOf(files);
    expect(rules).toContain(`gob-audit-reads ${page}`);
    expect(rules).toContain(`gob-audit-reads ${reader}`);
  });

  it("rule 3 — one more own-rows read on the /gob home is an error", () => {
    const file = "app/gob/page.tsx";
    const src = `${sourceOf(file)}\nexport async function extra() { return db.select().from(auditLog); }\n`;
    expect(rulesOf(withFile(file, src))).toContain(`gob-audit-reads ${file}`);
  });

  it("rule 4 — widening a platform-only action, and a new unpinned one", () => {
    const file = "app/actions/govt-reactivation.ts";
    const widened = sourceOf(file).replace(
      "await requireAdminOrRedirect();",
      "await requireAdministrationPrincipalOrRedirect();",
    );
    expect(rulesOf(withFile(file, widened))).toContain(
      `action-guards ${file}#reactivateGovtAction`,
    );
    const added = `${sourceOf(file)}\nexport async function extraAction() { await requireAdminOrRedirect(); }\n`;
    expect(rulesOf(withFile(file, added))).toContain(`action-guards ${file}#extraAction`);
  });

  it("rule 4 — pins every administration action file, reactivation included", () => {
    expect(Object.keys(ACTION_GUARD_INVENTORY)).toContain("app/actions/govt-reactivation.ts");
  });
});
