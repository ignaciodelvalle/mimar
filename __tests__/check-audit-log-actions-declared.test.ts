// The audit-action fence, tested BY BEING MADE TO FAIL.
//
// Its own header records why this file exists: the first version of the fence
// reported a clean pass over the exact bug it was written for, because it read
// a parameter's inline object TYPE as the function body and never registered
// `flushAuditLog`. Nobody noticed until a declared action was deleted by hand
// to see whether the run went red. Green on the real tree proves nothing about
// a scanner; only a fixture it is supposed to reject does.
//
// Every case below is a shape the 2026-08-23 review reproduced against the real
// repo and found INVISIBLE. They are fixtures, not paths, so they keep working
// when the modules that motivated them move.

import { describe, expect, it } from "vitest";

import { analyze, makeSourceFile } from "@/scripts/check-audit-log-actions-declared";

const DECLARED = new Set(["known_action", "capability_granted", "capability_revoked"]);

function run(files: Record<string, string>) {
  const sources = Object.entries(files).map(([rel, raw]) => makeSourceFile(rel, raw));
  return analyze(sources, DECLARED);
}

describe("audit-action fence — the writer index", () => {
  // THE SHAPE THAT MOTIVATED THE REWRITE. 20 sites over 16 actions in this repo
  // go action → repo.insertAudit, and the file-local index saw none of them.
  it("follows a repository relay into another file", () => {
    const { writers, scan } = run({
      "src/modules/x/infrastructure/x-repository.ts": `
        import { auditLog, db } from "@/db";
        export class XRepository {
          async insertAudit(values: NewAuditLogRow, executor = db) {
            await executor.insert(auditLog).values(values);
          }
        }
      `,
      "src/modules/x/application/do-thing.ts": `
        export async function doThing(repo: XRepository) {
          await repo.insertAudit({ actorUserId: "u", action: "undeclared_relay_action" });
        }
      `,
    });

    expect(writers.has("insertAudit")).toBe(true);
    expect(scan.undeclared.map((u) => u.action)).toContain("undeclared_relay_action");
  });

  // The two-hop in-file wrapper: high() → low() → insert. A single pass
  // registers `low` and stops, leaving every call of `high` — the one modules
  // actually call — unscanned.
  it("follows a two-hop wrapper inside one file", () => {
    const { scan } = run({
      "src/modules/y/actions.ts": `
        import { auditLog, db } from "@/db";
        async function low(entry: AuditEntry) {
          await db.insert(auditLog).values(entry as typeof auditLog.$inferInsert);
        }
        async function high(entry: AuditEntry) {
          await low(entry);
        }
        export async function act() {
          await high({ actorUserId: "u", action: "undeclared_two_hop_action" });
        }
      `,
    });

    expect(scan.undeclared.map((u) => u.action)).toContain("undeclared_two_hop_action");
  });

  // A private helper must NOT escape its file. Before the reachability rule the
  // index grew to 626 names because a one-off `async function main()` in a seed
  // script writes audit rows and every other script also has a `main`.
  it("does not export a private helper's name across files", () => {
    const { writers } = run({
      "scripts/seed-thing.ts": `
        import { auditLog, db } from "@/db";
        async function main(entry: AuditEntry) {
          await db.insert(auditLog).values(entry as typeof auditLog.$inferInsert);
        }
        main({ actorUserId: "u", action: "known_action" });
      `,
    });

    expect(writers.has("main")).toBe(false);
  });

  // A function that writes the literal itself is a WRITE, not a relay: its
  // callers pass nothing. Taking `writeAuditLog(tx, {…})`'s first argument as
  // evidence of forwarding made every server action with a `tx` parameter a
  // writer, and their call sites in client components got scanned.
  it("does not treat a literal-writing action as a relay", () => {
    const { writers } = run({
      "src/modules/z/actions.ts": `
        import { writeAuditLog } from "@/lib/infra/audit-log";
        export async function executeThingAction(input: Input, tx: Tx) {
          await writeAuditLog(tx, { actorUserId: input.id, action: "known_action" });
        }
      `,
    });

    expect(writers.has("executeThingAction")).toBe(false);
  });
});

describe("audit-action fence — resolving the action value", () => {
  // Hoisting the values object out of the call was invisible AND uncounted:
  // not flagged, and not in the dynamic ratchet either.
  it("resolves a values object hoisted into a local const", () => {
    const { scan } = run({
      "src/modules/w/actions.ts": `
        import { auditLog, db } from "@/db";
        export async function act() {
          const values = { actorUserId: "u", action: "undeclared_hoisted_action" };
          await db.insert(auditLog).values(values as typeof auditLog.$inferInsert);
        }
      `,
    });

    expect(scan.indirectCount).toBeGreaterThan(0);
    expect(scan.undeclared.map((u) => u.action)).toContain("undeclared_hoisted_action");
  });

  // An indexed lookup writes one of a closed set, and every member must be
  // declared — the same argument the ternary rule already made.
  it("resolves an indexed lookup into a local literal map", () => {
    const { scan } = run({
      "src/modules/v/decide.ts": `
        import { auditLog, db } from "@/db";
        export async function decide(input: Input) {
          const actionByDecision = {
            approved: "capability_granted",
            denied: "undeclared_map_action",
            revoked: "capability_revoked",
          } as const;
          await db.insert(auditLog).values({
            actorUserId: input.id,
            action: actionByDecision[input.decision],
          } as typeof auditLog.$inferInsert);
        }
      `,
    });

    expect(scan.undeclared.map((u) => u.action)).toEqual(["undeclared_map_action"]);
    expect(scan.unresolved).toEqual([]);
  });

  // A payload field that happens to be named `action` is not an audit action.
  it("ignores an action key nested below the top level", () => {
    const { scan } = run({
      "src/modules/u/actions.ts": `
        import { auditLog, db } from "@/db";
        export async function act() {
          await db.insert(auditLog).values({
            action: "known_action",
            payload: { action: "undeclared_nested_action" },
          } as typeof auditLog.$inferInsert);
        }
      `,
    });

    expect(scan.undeclared).toEqual([]);
  });

  // Example code inside a help string is prose. scripts/check-audit-log-
  // coverage.ts prints `await writeAuditLog(tx, { action, … })` as advice, and
  // it read as a live call site with an unresolvable action.
  it("does not read a call inside a string literal as a call site", () => {
    const { scan } = run({
      "scripts/advice.ts": `
        export function help() {
          console.error("  await writeAuditLog(tx, { action, actorUserId })");
        }
      `,
    });

    expect(scan.siteCount).toBe(0);
    expect(scan.unresolved).toEqual([]);
  });

  // A genuinely dynamic action is counted rather than passed over. This is the
  // residue the EXPECTED_DYNAMIC ratchet freezes on the real tree.
  it("counts an unresolvable action as dynamic residue", () => {
    const { scan } = run({
      "src/modules/t/replay.ts": `
        import { auditLog, db } from "@/db";
        export async function replay(row: QueueRow) {
          await db.insert(auditLog).values({
            actorUserId: row.actorId,
            action: row.action as AuditLogAction,
          } as typeof auditLog.$inferInsert);
        }
      `,
    });

    expect(scan.unresolved).toHaveLength(1);
    expect(scan.undeclared).toEqual([]);
  });

  // The relay's OWN body carries no literal — counting it as residue would
  // double-count the write its callers already declare.
  it("counts a relay body as pass-through, not as residue", () => {
    const { scan } = run({
      "src/modules/s/infrastructure/s-repository.ts": `
        import { auditLog, db } from "@/db";
        export class SRepository {
          async insertAudit(values: NewAuditLogRow, executor = db) {
            await executor.insert(auditLog).values(values);
          }
        }
      `,
    });

    expect(scan.passThroughCount).toBeGreaterThan(0);
    expect(scan.unresolved).toEqual([]);
  });
});
