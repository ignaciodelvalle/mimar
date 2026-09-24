// Unit tests for the audit-log coverage fence (scripts/check-audit-log-coverage.ts).
//
// A fence is a measuring instrument, and an instrument nobody calibrates
// eventually reads zero on everything. What is pinned here:
//
//   1. NON-VACUITY, against the REAL repository — the scan must find server
//      action modules AND derive operator+mutating candidates. This is the
//      guard that catches "discovery silently broke and the fence now passes
//      because it scans nothing", which is the failure mode this codebase has
//      hit repeatedly (see the 2026-08-05 "el gate miente" audit).
//   2. THE RULE ACTUALLY BITES — a synthetic operator action that mutates with
//      no audit write is flagged; the same action with the write is not.
//   3. THE BASELINE IS CURRENT — every entry still offends. A stale entry is
//      how a ratchet stops ratcheting, and 17 of the 18 other ratchets in this
//      repo have no such check.

import { describe, expect, it } from "vitest";

import {
  NO_AUDIT_COMMENT,
  OPERATOR_GUARDS,
  findCandidates,
  importedIdentifiers,
  readBaseline,
  scanAll,
} from "@/scripts/check-audit-log-coverage";

const HEADER =
  '"use server";\n\nimport { requireAdminOrGovtOrRedirect } from "@/lib/auth-guards";\n';

describe("check-audit-log-coverage — non-vacuity against the real repo", () => {
  const { candidates, actionFiles } = scanAll();

  it("discovers server-action modules", () => {
    expect(actionFiles).toBeGreaterThan(0);
  });

  it("derives operator+mutating candidates (a fence that matches nothing guards nothing)", () => {
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("finds actions that DO reach an audit write — the rule is not flagging everything", () => {
    expect(candidates.filter((c) => c.audited).length).toBeGreaterThan(0);
  });

  it("has no stale baseline entry — every baselined action still offends", () => {
    const stillUnaudited = new Set(candidates.filter((c) => !c.audited).map((c) => c.key));
    const stale = readBaseline().filter((k) => !stillUnaudited.has(k));
    expect(stale).toEqual([]);
  });
});

describe("check-audit-log-coverage — the rule", () => {
  it("flags an operator action that mutates with NO audit write", () => {
    const src = `${HEADER}
export async function banEverythingAction(orgId: string) {
  await requireAdminOrGovtOrRedirect();
  await db.update(organizations).set({ verified: false }).where(eq(organizations.id, orgId));
}
`;
    const found = findCandidates("app/actions/fake.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("banEverythingAction");
    expect(found[0].audited).toBe(false);
  });

  it("does NOT flag the same action once it writes the audit row", () => {
    const src = `${HEADER}
export async function banEverythingAction(orgId: string) {
  await requireAdminOrGovtOrRedirect();
  await db.transaction(async (tx) => {
    await tx.update(organizations).set({ verified: false }).where(eq(organizations.id, orgId));
    await writeAuditLog(tx, { action: "org_unverified", actorUserId: "x" });
  });
}
`;
    const found = findCandidates("app/actions/fake.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0].audited).toBe(true);
  });

  it("does NOT flag a personal-tier action — the rule is operator-scoped", () => {
    const src = `"use server";
import { requireUserOrRedirect } from "@/lib/auth-guards";

export async function updateMyPhoneAction(phone: string) {
  const { user } = await requireUserOrRedirect();
  await db.update(profiles).set({ phone }).where(eq(profiles.id, user.id));
}
`;
    expect(findCandidates("app/actions/fake.ts", src)).toEqual([]);
  });

  it("does NOT flag an operator READ — no mutation, nothing to account for", () => {
    const src = `${HEADER}
export async function listPendingAction() {
  await requireAdminOrGovtOrRedirect();
  return db.select().from(approvalRequests);
}
`;
    expect(findCandidates("app/actions/fake.ts", src)).toEqual([]);
  });

  it("treats an action whose only write IS its audit row as audit-only, not a mutation", () => {
    const src = `${HEADER}
export async function logExportAction() {
  await requireAdminOrGovtOrRedirect();
  await db.insert(auditLog).values({ action: "analytics_export_generated" });
}
`;
    expect(findCandidates("app/actions/fake.ts", src)).toEqual([]);
  });

  it(`honors a documented \`${NO_AUDIT_COMMENT}\` opt-out above the export`, () => {
    const src = `${HEADER}
// ${NO_AUDIT_COMMENT}: advances the caller's OWN read watermark; no third party is affected.
export async function markSeenAction() {
  await requireAdminOrGovtOrRedirect();
  await db.insert(watermarks).values({});
}
`;
    const found = findCandidates("app/actions/fake.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0].audited).toBe(true);
  });

  it("accepts a CALL to a repository audit writer (`repo.insert…AuditLog(…)`) as the audit write", () => {
    const src = `${HEADER}
export async function closeThingAction(id: string) {
  await requireAdminOrGovtOrRedirect();
  await db.transaction(async (tx) => {
    await tx.update(things).set({ closed: true }).where(eq(things.id, id));
    await repo.insertThingCloseAuditLog({ action: "thing_closed", actorUserId: "x" }, tx);
  });
}
`;
    const found = findCandidates("app/actions/fake.ts", src);
    expect(found).toHaveLength(1);
    expect(found[0].audited).toBe(true);
  });

  it("does not accept a repository audit writer that is only NAMED, never called", () => {
    const src = `${HEADER}
export async function closeThingAction(id: string) {
  await requireAdminOrGovtOrRedirect();
  const writer = "insertThingCloseAuditLog";
  await db.update(things).set({ closed: true }).where(eq(things.id, id));
}
`;
    expect(findCandidates("app/actions/fake.ts", src)[0].audited).toBe(false);
  });

  it("does not accept an audit identifier that appears only in a COMMENT", () => {
    const src = `${HEADER}
export async function banEverythingAction(orgId: string) {
  await requireAdminOrGovtOrRedirect();
  // TODO: call writeAuditLog / insert auditLog here
  await db.update(organizations).set({ verified: false }).where(eq(organizations.id, orgId));
}
`;
    expect(findCandidates("app/actions/fake.ts", src)[0].audited).toBe(false);
  });

  // 2026-08-22 — the class the fence could not see at all.
  //
  // OPERATOR_GUARDS held only the four admin/govt guards, so a capability-gated
  // org write was never derived as a candidate: not flagged, not baselined, not
  // exempted. The summary line kept reading "coverage clean" about a set that
  // excluded the whole class, which is how the org bite report went a year with
  // no audit row and nothing noticed.
  describe("capability-gated org writes are visible (H1)", () => {
    const CAP_HEADER =
      '"use server";\n\nimport { requireCapability, requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";\n';

    it("flags a hand-written capability-gated mutation with NO audit write", () => {
      const src = `${CAP_HEADER}
export async function seizeThatAnimalAction(petId: string) {
  const cap = await requireCapability("custody.transfer");
  await db.update(pets).set({ status: "deceased" }).where(eq(pets.id, petId));
}
`;
      const found = findCandidates("app/actions/fake.ts", src);
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe("seizeThatAnimalAction");
      expect(found[0].audited).toBe(false);
    });

    it("flags the URL-pinned variant too — the name that does NOT match the bare regex", () => {
      // `callsAnyOf` builds `\\brequireCapability\\s*\\(`, which does not match
      // `requireCapabilityForOrgToken(`. Listing only the bare name would have
      // re-created the blind spot for exactly the actions careful enough to pin
      // their org scope — the ones LEAST deserving of an exemption.
      const src = `${CAP_HEADER}
export async function seizeThatAnimalAction(orgToken: string, petId: string) {
  const cap = await requireCapabilityForOrgToken("custody.transfer", orgToken);
  await db.update(pets).set({ status: "deceased" }).where(eq(pets.id, petId));
}
`;
      const found = findCandidates("app/actions/fake.ts", src);
      expect(found.map((c) => ({ name: c.name, audited: c.audited }))).toEqual([
        { name: "seizeThatAnimalAction", audited: false },
      ]);
    });

    it("clears the same action once it writes the row inside its transaction", () => {
      const src = `${CAP_HEADER}
export async function seizeThatAnimalAction(orgToken: string, petId: string) {
  const cap = await requireCapabilityForOrgToken("custody.transfer", orgToken);
  await db.transaction(async (tx) => {
    await tx.update(pets).set({ status: "deceased" }).where(eq(pets.id, petId));
    await writeAuditLog(tx, { action: "decomiso_executed", actorUserId: cap.user.id });
  });
}
`;
      const found = findCandidates("app/actions/fake.ts", src);
      expect(found).toHaveLength(1);
      expect(found[0].audited).toBe(true);
    });

    it("derives capability-gated candidates from the REAL repo, not only fixtures", () => {
      // The fixtures above prove the rule; this proves the rule reaches
      // production code. Before 2026-08-22 this count was ZERO by construction.
      const { candidates } = scanAll();
      const capabilityGated = candidates.filter((c) =>
        /^(app\/actions\/(attendance|chip-match|intake|schedule-rules|service-offerings)|app\/org\/|src\/modules\/(adoption|foster|surveillance)\/)/.test(
          c.relPath,
        ),
      );
      expect(capabilityGated.length).toBeGreaterThan(0);
    });
  });

  it("recognises every operator guard, not just the one the fixtures use", () => {
    for (const guard of OPERATOR_GUARDS) {
      const src = `"use server";
import { ${guard} } from "@/lib/auth-guards";

export async function mutateAction() {
  await ${guard}();
  await db.update(pets).set({ name: "x" });
}
`;
      const found = findCandidates("app/actions/fake.ts", src);
      expect(
        found.map((c) => c.name),
        `guard ${guard} was not recognised`,
      ).toEqual(["mutateAction"]);
    }
  });
});

describe("importedIdentifiers — module-level alias resolution", () => {
  it("maps a repository alias back to the module it was constructed from", () => {
    const map = importedIdentifiers(`
import { WelfareRepository } from "./infrastructure/welfare-repository";
const repo = new WelfareRepository();
`);
    // Without this, `repo.insertAudit(...)` resolves to nothing and the action
    // reads as unaudited — a measured false positive on the fence's first run.
    expect(map.get("repo")).toBe("./infrastructure/welfare-repository");
  });

  it("ignores node-module specifiers", () => {
    const map = importedIdentifiers('import { z } from "zod/v4";\n');
    expect(map.has("z")).toBe(false);
  });
});
