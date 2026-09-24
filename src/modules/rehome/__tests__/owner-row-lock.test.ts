// Source pin: the accept transaction locks the titular's live `owner` row.
// Layer: Unit (reads source, no DB). WU3 review, L-1.
//
// WHY A SOURCE PIN AND NOT A LOCK HARNESS
// ---------------------------------------------------------------------------
// ADR-1 step 2 asserts the consenting titular still holds a live `owner` row,
// under the CASE lock only. A person-to-person transfer committing between that
// read and the step-5 insert would grant an org custody on the consent of an
// ex-owner. `SELECT ... FOR UPDATE` on the owner row closes that window: the
// transfer's own close of the row then blocks behind this transaction, and the
// transaction after it re-reads a closed row and refuses.
//
// The repo has no concurrent-transaction harness precedent (no pg_locks /
// NOWAIT assertions anywhere under __tests__ or src), so this pins the SOURCE:
// the read the use-case makes inside the transaction is the locking one, and
// the locking one really says `.for("update")`. The unlocked read still exists
// for the request path, which runs outside any transaction.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_ROOT = join(__dirname, "..");
const REPO_ROOT = join(MODULE_ROOT, "..", "..", "..");
const repositorySrc = readFileSync(
  join(MODULE_ROOT, "infrastructure", "rehome-repository.ts"),
  "utf8",
);
const respondSrc = readFileSync(
  join(MODULE_ROOT, "application", "respond-to-rehome-request.ts"),
  "utf8",
);

/** The body of one `async name(` method of the repository object literal. */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  expect(start, `${name} is not a method of RehomeRepository`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\n  async ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("respond-to-rehome-request — the titular's owner row is locked under the accept transaction", () => {
  it("RehomeRepository.lockLiveOwnerRow reads the live owner row FOR UPDATE", () => {
    const body = methodBody(repositorySrc, "lockLiveOwnerRow");
    expect(body).toContain('eq(ownerships.role, "owner")');
    expect(body).toContain("isNull(ownerships.endedAt)");
    expect(body).toContain('.for("update")');
  });

  it("the unlocked read stays unlocked — the request path runs outside a transaction", () => {
    const body = methodBody(repositorySrc, "findLiveOwnerRow");
    expect(body).not.toContain('.for("update")');
  });

  it("the accept transaction calls the locking read, never the unlocked one", () => {
    expect(respondSrc).toContain("repo.lockLiveOwnerRow(");
    expect(respondSrc).not.toContain("repo.findLiveOwnerRow(");
  });
});

// WU3 review, M-1 residual: step 1b re-reads the accepting org inside the
// transaction, but a plain SELECT still lets a de-verification COMMIT between
// that read and the custody insert — the accept then signs `verified: true`
// on an org that is not. `FOR SHARE` makes the de-verifying UPDATE wait behind
// this transaction (and vice versa), so the row the accept believes is the row
// that holds when it commits. SHARE, not UPDATE: two accepts of two different
// requests addressed to the same org must not serialise on the org row.
describe("respond-to-rehome-request — the accepting org row is locked FOR SHARE under the accept transaction", () => {
  it("RehomeRepository.lockOrgForShare reads the org row FOR SHARE", () => {
    const body = methodBody(repositorySrc, "lockOrgForShare");
    expect(body).toContain("eq(organizations.id, orgId)");
    expect(body).toContain('.for("share")');
  });

  it("the unlocked read stays unlocked — the request path runs outside a transaction", () => {
    const body = methodBody(repositorySrc, "findOrgById");
    expect(body).not.toContain('.for("share")');
    expect(body).not.toContain('.for("update")');
  });

  it("the accept transaction calls the locking read, never the unlocked one", () => {
    expect(respondSrc).toContain("repo.lockOrgForShare(");
    expect(respondSrc).not.toContain("repo.findOrgById(");
  });
});

// WU5 review (LOW): LOCK ORDER. Finalize locked the custody row first and then
// closed every live row (the titular's owner row among them); the withdraw
// locked the titular's owner row first and then closed the custody row. Two
// row locks taken in opposite orders by two transactions on the same pet is a
// deadlock window, and Postgres resolves it by killing one side with 40P01 —
// which the withdraw's action surfaced as an unhandled error. Every pet-scoped
// custody writer of this feature now takes ONE lock first, in the same place:
// `pg_advisory_xact_lock(hashtext(petId))`, the repo's own precedent for
// serialising custody writers (chip-match, return-to-owner, cross-org
// transfer). Row locks after it can no longer form a cycle.
describe("rehome — every transaction takes the pet advisory lock BEFORE any row lock", () => {
  const withdrawSrc = readFileSync(
    join(MODULE_ROOT, "application", "withdraw-rehome-sponsorship.ts"),
    "utf8",
  );

  it("RehomeRepository.acquirePetAdvisoryLock is the transaction-scoped pet lock", () => {
    const body = methodBody(repositorySrc, "acquirePetAdvisoryLock");
    expect(body).toContain("pg_advisory_xact_lock(hashtext(");
  });

  it("the withdraw takes it inside its transaction, before the owner-row lock", () => {
    const txStart = withdrawSrc.indexOf("runWithdrawTransaction(pet.name, deps, async (tx) =>");
    expect(txStart, "the withdraw transaction").toBeGreaterThanOrEqual(0);
    const lockAt = withdrawSrc.indexOf("repo.acquirePetAdvisoryLock(", txStart);
    const ownerRowAt = withdrawSrc.indexOf("repo.lockLiveOwnerRow(", txStart);
    expect(lockAt, "acquirePetAdvisoryLock inside the transaction").toBeGreaterThan(txStart);
    expect(ownerRowAt).toBeGreaterThan(lockAt);
  });

  it("the accept takes it inside its transaction, before the case lock", () => {
    const txStart = respondSrc.indexOf("runAnswerTransaction(deps, async (tx) =>");
    expect(txStart, "the accept transaction").toBeGreaterThanOrEqual(0);
    const lockAt = respondSrc.indexOf("repo.acquirePetAdvisoryLock(", txStart);
    const caseLockAt = respondSrc.indexOf("repo.lockRequestCase(", txStart);
    expect(lockAt, "acquirePetAdvisoryLock inside the transaction").toBeGreaterThan(txStart);
    expect(caseLockAt).toBeGreaterThan(lockAt);
  });
});

// Loop fase 1, L-9 (2026-08-23): the writers the allowlist below names as the
// KNOWN GAP — "the three decomiso writers and the custody-dispute resolution do
// not [take the pet lock]". That gap is the deadlock (40P01) half of M-9: the
// duplicate event is closed by the helper's own `FOR UPDATE`, but a decomiso
// committing concurrently with a withdraw or a finalize still takes the same
// row locks in the opposite order, and Postgres breaks that cycle by killing
// one side. Each of these four opens (or is the first call inside) its own
// transaction, so the lock goes at that boundary — first, before any row lock.
//
// `pg_advisory_xact_lock(hashtext(petId))` is the repo's one key for
// serialising pet-scoped custody writers: adoption's `acquirePetAdvisoryLock`,
// rehome's, the chip-match / return-to-owner / cross-org writers, and (since
// M-8) both foster closers all take that exact key.
describe("custody hand-offs outside the rehome feature take the pet advisory lock first (L-9)", () => {
  const LOCK = "pg_advisory_xact_lock(hashtext(";

  // Each entry: the file, and the first custody write that must come AFTER the
  // lock. Naming the write (not just "somewhere in the file") is what stops a
  // lock drifting below the thing it is supposed to serialise.
  const WRITERS: Array<{ rel: string; firstWrite: string }> = [
    { rel: "src/modules/decomiso/application/execute-decomiso.ts", firstWrite: "libOpenCase(" },
    {
      rel: "src/modules/decomiso/application/accept-decomiso-handoff.ts",
      firstWrite: "tx.insert(petEvents)",
    },
    {
      rel: "src/modules/decomiso/application/return-custody-to-owner.ts",
      firstWrite: "tx.insert(petEvents)",
    },
    {
      rel: "src/modules/custody-disputes/application/resolve-dispute.ts",
      firstWrite: "endAllLiveOwnerships(",
    },
  ];

  for (const { rel, firstWrite } of WRITERS) {
    it(`${rel}: the pet advisory lock comes before ${firstWrite}`, () => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      const lockAt = src.indexOf(LOCK);
      const writeAt = src.indexOf(firstWrite);
      expect(lockAt, `${LOCK} in ${rel}`).toBeGreaterThanOrEqual(0);
      expect(writeAt, `${firstWrite} in ${rel}`).toBeGreaterThanOrEqual(0);
      expect(lockAt).toBeLessThan(writeAt);
    });
  }
});

// Loop fase 1, M-9 (2026-08-23): `endAllLiveOwnerships` guards its sponsorship
// close on "is that custody row still LIVE" — and that guard is a PLAIN select.
// A plain select reads the last committed version, so it answers "yes, live"
// even when a concurrent transaction has already closed the row and not yet
// committed. Both transactions then write `rehome_sponsorship_ended` over the
// same custody with DIFFERENT outcomes and DIFFERENT authors (a titular's
// withdraw racing an authority's decomiso), and the spine is append-only: two
// contradictory sentences printed forever in the animal's official record.
// Nothing below catches it — no unique index on the custody key inside the
// payload, no idempotency key on this writer, and `lint:spine` only reports the
// MIRROR drift (a closed custody with no event).
//
// `FOR UPDATE` closes it: the losing transaction blocks behind the winner's
// close of that very row, re-checks `ended_at IS NULL` under EvalPlanQual, drops
// out, and writes no second event. Same table and same pattern as the caretaker
// read twenty lines above, and the blanket UPDATE three statements later locks
// those rows anyway — so this buys serialisation, not a new lock.
//
// This closes the DUPLICATE-EVENT half only. The deadlock half (40P01) needs
// the pet advisory lock to reach the three decomiso writers and
// resolve-dispute.ts — the gap LOCK_IS_THE_CALLERS_DUTY names above.
describe("end-pet-ownerships — the live-sponsorship-row re-read is locked (M-9)", () => {
  const endSrc = readFileSync(join(REPO_ROOT, "lib/infra/end-pet-ownerships.ts"), "utf8");

  /** The body of `endAllLiveOwnerships`, up to the next top-level export. */
  function endAllLiveOwnershipsBody(): string {
    const start = endSrc.indexOf("export async function endAllLiveOwnerships(");
    expect(start, "endAllLiveOwnerships").toBeGreaterThanOrEqual(0);
    const next = endSrc.indexOf("\nexport ", start + 1);
    return endSrc.slice(start, next === -1 ? undefined : next);
  }

  it("re-reads the sponsorship's live ownership row FOR UPDATE", () => {
    const body = endAllLiveOwnershipsBody();
    const readAt = body.indexOf("const [liveSponsorRow]");
    expect(readAt, "the live-sponsorship-row read").toBeGreaterThanOrEqual(0);
    const readEnd = body.indexOf("if (liveSponsorRow)", readAt);
    expect(readEnd, "the guard that consumes it").toBeGreaterThan(readAt);
    const readBlock = body.slice(readAt, readEnd);
    expect(readBlock).toContain("isNull(ownerships.endedAt)");
    expect(readBlock).toContain('.for("update")');
  });

  it("the caretaker read it mirrors is still locked — the precedent, same file, same table", () => {
    const readAt = endSrc.indexOf("const liveCaretakerGrants");
    expect(readAt, "the live-caretaker-grants read").toBeGreaterThanOrEqual(0);
    const readEnd = endSrc.indexOf("for (const grant of liveCaretakerGrants)", readAt);
    expect(endSrc.slice(readAt, readEnd)).toContain('.for("update")');
  });
});

// WU6/7 review (M-1): the death of a sponsored pet ends the sponsorship inside
// the death transaction — which had already closed the foster rows and updated
// the pets row before it reached for the custody row, and took no pet lock at
// all. Finalize holds the pet lock while it touches those same rows: the cycle
// the WU5 fix closed was open again, one writer over. The arms above pin the
// writers they NAME, and a writer nobody named is exactly the one that slips.
// This arm DISCOVERS them: every file that ends custody must take the pet
// advisory lock before it does, in the same file — or be listed below with the
// reason its lock lives somewhere else.
//
// WIDENED 2026-08-23 (loop fase 1, §6 item 1). It used to search ONE literal,
// `endRehomeSponsorship(`, and that is exactly why it never saw the foster
// convert writer (M-8) — which DOES end a sponsorship, only transitively,
// through `endAllLiveOwnerships`. *A fence enumerates forms, not the thing*, and
// this repo has paid for that lesson more than once: ban the SUBJECT, not one
// of its spellings.
//
// So the call list is DERIVED from the exported functions of the two files that
// DEFINE a custody ending. A new exported ender is covered the day it is
// written, and an export that is NOT an ender has to say so, by name, in
// `NOT_A_CUSTODY_ENDER` — which is where the next person is forced to think
// instead of quietly adding a third literal to a list.
describe("rehome — every writer that ENDS custody takes the pet advisory lock first", () => {
  const SCAN_DIRS = ["lib", "src", "scripts"];
  const WRITER = "src/modules/adoption/infrastructure/rehome-sponsorship-writer.ts";
  const LOCK = /acquirePetAdvisoryLock\(|pg_advisory_xact_lock\(hashtext\(/;

  /** The files whose exports ARE the custody-ending vocabulary. */
  const PRIMITIVE_FILES = [WRITER, "lib/infra/end-pet-ownerships.ts"];

  /** Exports of those files that do not end anything, each with its reason. */
  const NOT_A_CUSTODY_ENDER: Record<string, string> = {
    findOpenSponsorship: "read — the spine predicate for 'is this row sponsored'",
    listOpenSponsorships: "read — same predicate, many pets",
    listOpenSponsorshipPetIds: "read — same predicate, ids only",
    notifyCaretakersOfHandoff: "post-tx notification fan-out; touches no ownership row",
  };

  /** `name(` for every exported ending, derived — never a hand-kept literal list. */
  function endingCalls(): string[] {
    const out: string[] = [];
    for (const rel of PRIMITIVE_FILES) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      for (const m of src.matchAll(/^export async function (\w+)\(/gm)) {
        if (NOT_A_CUSTODY_ENDER[m[1]]) continue;
        out.push(`${m[1]}(`);
      }
    }
    return out.sort();
  }

  const CALLS = endingCalls();

  /** Index of the first custody-ending call in a source, or -1. */
  function firstEndingCallAt(src: string): number {
    let best = -1;
    for (const call of CALLS) {
      const at = src.indexOf(call);
      if (at >= 0 && (best === -1 || at < best)) best = at;
    }
    return best;
  }

  /**
   * THE RULE, as a function of one file's text — so the planted-writer arm can
   * run the very same predicate the fence runs, instead of a paraphrase of it.
   */
  function breaksTheRule(src: string): boolean {
    const callAt = firstEndingCallAt(src);
    if (callAt < 0) return false;
    const lockAt = src.search(LOCK);
    return lockAt < 0 || lockAt > callAt;
  }

  // Files that end custody but take the lock ELSEWHERE, each with the reason
  // and — where one exists — the pin that proves the lock is really taken.
  const LOCK_IS_THE_CALLERS_DUTY: Record<string, string> = {
    "lib/infra/end-pet-ownerships.ts":
      "The primitive itself. It runs INSIDE its caller's transaction, so a lock taken here would come after the caller's own row locks and would not be first. Every caller now takes it: finalize (before lockLiveCustodyRow), the three decomiso writers, the dispute resolution and both foster closers — pinned by the L-9 arm above and by finalize-custody-lock.test.ts.",
    "src/modules/adoption/infrastructure/adoption-finalize-writer.ts":
      "Writer half of finalizeAdoption, always called from that use-case's transaction, which takes acquirePetAdvisoryLock before lockLiveCustodyRow. Pinned by src/modules/adoption/__tests__/finalize-custody-lock.test.ts.",
    "src/modules/transfers/infrastructure/transfers-repository.ts":
      "closeOwnerOwnerships is a pass-through delegate to endCaretakerArrangementsForPet, called from acceptPetTransfer's transaction. That transaction serialises on the transfer row (findTransferByIdForUpdate) and re-asserts the sender is still the single active owner, so a hand-off it lost cannot pass. OPEN RESIDUAL: it does not take the PET lock, so it can still cross lock order with a withdraw or a finalize. Reported, not fixed here — loop fase 1 L-9 scoped the lock to the decomiso writers and the dispute resolution.",
    "src/modules/caretakers/infrastructure/caretakers-repository.ts":
      "insertEndGrant is a pass-through delegate to endCaretakerGrantAtomically, called from end-caretaker-grant and the expiry cron. OPEN RESIDUAL: neither takes the pet lock — the caretaker race loop fase 1 records as L-9's other half. Reported, not fixed here.",
  };

  function walk(dir: string, acc: string[]): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === "__tests__") continue;
        walk(full, acc);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        acc.push(full);
      }
    }
  }

  function callers(): Array<{ rel: string; src: string }> {
    const out: Array<{ rel: string; src: string }> = [];
    for (const base of SCAN_DIRS) {
      const files: string[] = [];
      walk(join(REPO_ROOT, base), files);
      for (const abs of files) {
        const rel = relative(REPO_ROOT, abs).split(sep).join("/");
        if (rel === WRITER) continue;
        const src = readFileSync(abs, "utf8");
        if (firstEndingCallAt(src) >= 0) out.push({ rel, src });
      }
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const found = callers();

  it("derives the ending vocabulary from the primitives, not from a literal", () => {
    // The two that existed before the widening, plus the ones that made M-8
    // invisible. If a primitive grows a new exported ender it lands here for
    // free; if it grows a non-ender, NOT_A_CUSTODY_ENDER makes someone say so.
    expect(CALLS).toEqual([
      "endAllLiveOwnerships(",
      "endCaretakerArrangementsForPet(",
      "endCaretakerGrantAtomically(",
      "endRehomeSponsorship(",
    ]);
  });

  it("discovers the callers — the fence is not vacuous", () => {
    const rels = found.map((f) => f.rel);
    expect(rels).toContain("lib/infra/rehome-death-cascade.ts");
    expect(rels).toContain("scripts/rollback-rehome-sponsorships.ts");
    expect(rels).toContain("src/modules/rehome/infrastructure/rehome-repository.ts");
    // The three the OLD literal could not see. The foster convert writer is the
    // one that made M-8 possible: it ends a sponsorship transitively, so the
    // string `endRehomeSponsorship(` appears in it zero times.
    expect(rels).toContain("src/modules/foster/infrastructure/foster-convert-to-owner-writer.ts");
    expect(rels).toContain("src/modules/decomiso/application/execute-decomiso.ts");
    expect(rels).toContain("src/modules/custody-disputes/application/resolve-dispute.ts");
  });

  it("every allowlisted file still ends custody — no stale exemptions", () => {
    const rels = new Set(found.map((f) => f.rel));
    for (const rel of Object.keys(LOCK_IS_THE_CALLERS_DUTY)) {
      expect(rels.has(rel), `${rel} is exempted but no longer ends custody`).toBe(true);
    }
  });

  // NON-VACUITY, the part that matters: the rule really rejects a writer that
  // closes custody without the lock. It runs the SAME predicate the arms below
  // run — not a paraphrase of it — over a writer that does not exist in the
  // tree, so a rule that had quietly stopped matching anything would fail here.
  it("flags a planted writer that ends custody without the lock", () => {
    const planted = [
      "export async function seizeEverything(petId: string, tx: Tx) {",
      '  await endAllLiveOwnerships({ petId, outcome: "ownership_transferred" }, tx);',
      "}",
    ].join("\n");
    expect(breaksTheRule(planted)).toBe(true);

    const withLock = [
      "export async function seizeEverything(petId: string, tx: Tx) {",
      "  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);",
      '  await endAllLiveOwnerships({ petId, outcome: "ownership_transferred" }, tx);',
      "}",
    ].join("\n");
    expect(breaksTheRule(withLock)).toBe(false);

    // And the lock BELOW the call is still a violation — order is the rule.
    const lockTooLate = [
      "export async function seizeEverything(petId: string, tx: Tx) {",
      '  await endAllLiveOwnerships({ petId, outcome: "ownership_transferred" }, tx);',
      "  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${petId}))`);",
      "}",
    ].join("\n");
    expect(breaksTheRule(lockTooLate)).toBe(true);

    // A file that ends nothing is not the fence's business.
    expect(breaksTheRule("export function render() { return null; }")).toBe(false);
  });

  for (const { rel, src } of found) {
    if (LOCK_IS_THE_CALLERS_DUTY[rel]) continue;
    it(`${rel}: the pet advisory lock comes before it ends custody`, () => {
      expect(breaksTheRule(src), `${rel} ends custody with no lock before it`).toBe(false);
    });
  }

  it("the death transaction takes it FIRST — before the death event, the pets projection, the foster closes and CASCADE D", () => {
    const deathSrc = readFileSync(
      join(REPO_ROOT, "src/modules/events/application/lifecycle/death-record-use-case.ts"),
      "utf8",
    );
    const txStart = deathSrc.indexOf("deps.transaction(async (tx) =>");
    expect(txStart, "the death transaction").toBeGreaterThanOrEqual(0);
    const lockAt = deathSrc.indexOf("lockPetForDeathRecord(", txStart);
    expect(lockAt, "lockPetForDeathRecord inside the transaction").toBeGreaterThan(txStart);
    for (const later of [
      "insertEventIdempotent(",
      "updateDeceased(",
      "findActiveFosters(",
      "endSponsorshipForDeceasedPet(",
    ]) {
      expect(deathSrc.indexOf(later, txStart), `${later} after the lock`).toBeGreaterThan(lockAt);
    }
  });
});
