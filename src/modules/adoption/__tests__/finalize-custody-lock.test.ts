// Source pin: the finalize transaction locks the custody row it is about to
// close. Layer: Unit (reads source, no DB). rehome-by-titular, WU5 carry-forward 3.
//
// WHY A SOURCE PIN BESIDE THE USE-CASE TEST
// ---------------------------------------------------------------------------
// The use-case test proves finalize CALLS `lockLiveCustodyRow` before writing
// and refuses when it returns null. It cannot prove the repository method is a
// lock: a double returns whatever the test says. This pins the SQL — the read
// really says `.for("update")` and really filters `ended_at IS NULL`, so a
// titular's withdraw committing between finalize's pre-read and its
// transaction is either waited on (row locked by the withdraw) or seen (row
// already ended). Same precedent as src/modules/rehome/__tests__/owner-row-lock.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_ROOT = join(__dirname, "..");
const repositorySrc = readFileSync(
  join(MODULE_ROOT, "infrastructure", "adoption-repository.ts"),
  "utf8",
);
const finalizeSrc = readFileSync(join(MODULE_ROOT, "application", "finalize-adoption.ts"), "utf8");

/** The body of one `async name(` method of the repository object literal. */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`async ${name}(`);
  expect(start, `${name} is not a method of AdoptionRepository`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("\n  async ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("finalize-adoption — the custody row is locked under the finalize transaction", () => {
  it("AdoptionRepository.lockLiveCustodyRow reads the LIVE row by id FOR UPDATE", () => {
    const body = methodBody(repositorySrc, "lockLiveCustodyRow");
    expect(body).toContain("eq(ownerships.id, ownershipId)");
    expect(body).toContain("isNull(ownerships.endedAt)");
    expect(body).toContain('.for("update")');
  });

  it("the pre-transaction read stays unlocked — it is the readable refusal, not the guard", () => {
    const body = methodBody(repositorySrc, "findShelterPet");
    expect(body).not.toContain('.for("update")');
  });

  it("the use-case locks inside the transaction, before the composite write", () => {
    const txStart = finalizeSrc.indexOf("await transaction(async (tx) =>");
    expect(txStart, "the finalize transaction").toBeGreaterThanOrEqual(0);
    const lockAt = finalizeSrc.indexOf("repo.lockLiveCustodyRow(", txStart);
    const writeAt = finalizeSrc.indexOf("repo.insertAdoptionFinalized(", txStart);
    expect(lockAt, "lockLiveCustodyRow is called inside the transaction").toBeGreaterThan(txStart);
    expect(writeAt).toBeGreaterThan(lockAt);
  });
});

// WU5 review (LOW): LOCK ORDER with the titular's withdraw. Finalize locked the
// custody row and then closed the owner row; the withdraw locked the owner row
// and then closed the custody row — a deadlock cycle Postgres breaks with
// 40P01. Both now take the pet advisory lock FIRST (the chip-match /
// return-to-owner / cross-org precedent), so the row locks below it can no
// longer be taken in opposite orders. Pinned on both sides: this file for
// finalize, src/modules/rehome/__tests__/owner-row-lock.test.ts for the withdraw.
describe("finalize-adoption — the pet advisory lock comes before the custody-row lock", () => {
  it("AdoptionRepository.acquirePetAdvisoryLock is the transaction-scoped pet lock", () => {
    const body = methodBody(repositorySrc, "acquirePetAdvisoryLock");
    expect(body).toContain("pg_advisory_xact_lock(hashtext(");
  });

  it("the use-case takes it inside the transaction, before lockLiveCustodyRow", () => {
    const txStart = finalizeSrc.indexOf("await transaction(async (tx) =>");
    const advisoryAt = finalizeSrc.indexOf("repo.acquirePetAdvisoryLock(", txStart);
    const lockAt = finalizeSrc.indexOf("repo.lockLiveCustodyRow(", txStart);
    expect(advisoryAt, "acquirePetAdvisoryLock inside the transaction").toBeGreaterThan(txStart);
    expect(lockAt).toBeGreaterThan(advisoryAt);
  });
});
