// One predicate for "which humans do we notify", and a ratchet over the copies
// that have not been migrated yet.
//
// WHY THIS FENCE EXISTS — A FIX THAT REACHED ONE OF NINE SITES
// ---------------------------------------------------------------------------
// On 2026-08-17 an audit found `findAuthoritiesForJurisdiction`'s admin
// fallback counting SERVICE ACCOUNTS as people. It was fixed there. A second
// audit hours later found the same query hand-rolled across eight more
// recipient paths — none with the fix, two also missing `deactivatedAt`. The
// first fix had been applied to the SITE the audit named instead of to the
// CONCEPT it was about.
//
// A test that re-checked the helper's behaviour would have stayed green through
// all of it, because the helper was never wrong. Only counting the SITES can
// catch a site that never asked the helper.
//
// HOW THE RATCHET WORKS
// ---------------------------------------------------------------------------
// BASELINE below lists the files that still hand-roll the predicate. It may
// only SHRINK. A new file with a hand-rolled copy fails; a migrated file that
// is still listed fails too, so the list cannot rot into a lie about how much
// work is left. Both directions are asserted on purpose — a stale allowlist
// that silently over-reports debt is the same defect as one that under-reports
// it, and this repo has been bitten by exactly that (the metric-contract fence
// claimed ~80 pending tiles when the sweep was already done).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/**
 * The shape of a hand-rolled recipient query: a Drizzle read over `profiles`
 * filtered by the admin role. Deliberately broader than the full four-clause
 * predicate — the defect IS the missing clause, so keying on the complete form
 * would match only the correct copies.
 */
const HAND_ROLLED = /\.from\(profiles\)/;
const ADMIN_ROLE = /eq\(\s*profiles\.role\s*,\s*"admin"\s*\)/;

/**
 * Files that still derive the recipient set themselves. MAY ONLY SHRINK.
 *
 * Each entry is a real notification-recipient path that should eventually call
 * `activeHumanInstitutionalAdminIds()`. They are listed rather than fixed in
 * one sweep because several sit inside transactions or select extra columns,
 * and a blind mechanical edit across nine writers the evening before a
 * demo is how a fix becomes an incident. The two with actual silent-loss
 * consequences — the stale-dispute and stale-decomiso escalations — were
 * migrated the same day this list was written.
 */
/**
 * The predicate's own home. Excluded rather than baselined: it is not debt, it
 * is the definition — the same distinction `check-jurisdiction-subsumption.ts`
 * draws with its SANCTIONED set for `jurisdiction-canonical.ts`.
 */
const CANONICAL_HOME = "lib/infra/notification-recipients.ts";

const BASELINE: readonly string[] = [
  // The two `/admin/admins` surfaces read profiles to LIST administrators for a
  // human, not to fan out a notification. Listed rather than exempted because
  // the query shape is identical, and a future reader should find that
  // distinction written down instead of re-deriving it.
  "app/admin/admins/AdminsScreen.tsx",
  "app/admin/admins/[userId]/page.tsx",
  "app/api/cron/auto-expire-approvals/route.ts",
  "lib/infra/outbox-drainer.ts",
  "src/modules/decomiso/application/execute-decomiso.ts",
  "src/modules/pets/application/microchip/replace-microchip.ts",
  "src/modules/pets/application/profile/govt-self-deactivate.ts",
  "src/modules/welfare/infrastructure/welfare-repository.ts",
];

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of ["app", "lib", "src"]) {
    for (const entry of readdirSync(join(ROOT, root), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      found.push(
        join(entry.parentPath, entry.name)
          .slice(ROOT.length + 1)
          .replaceAll("\\", "/"),
      );
    }
  }
  return found;
}

/** Files that select from `profiles` filtered by the admin role. */
function handRolledSites(): string[] {
  return sourceFiles()
    .filter((f) => f !== CANONICAL_HOME)
    .filter((f) => {
      const src = readFileSync(join(ROOT, f), "utf8");
      return HAND_ROLLED.test(src) && ADMIN_ROLE.test(src);
    })
    .sort();
}

describe("the notification-recipient predicate has one home", () => {
  it("scans a real source tree", () => {
    // NON-VACUITY: without this, a broken walk turns every assertion below into
    // a pass over an empty list.
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it("adds no NEW hand-rolled copy outside the baseline", () => {
    const unexpected = handRolledSites().filter((f) => !BASELINE.includes(f));
    expect(unexpected).toEqual([]);
  });

  it("keeps the baseline honest — a migrated file must leave the list", () => {
    // The other direction. A file that no longer hand-rolls the query but is
    // still listed makes the debt look larger than it is, and the next reader
    // wastes a pass discovering that.
    // HOISTED, and that is a fix rather than a tidy. Inline inside the filter
    // callback, `handRolledSites()` — a recursive walk of app/lib/src that
    // `readFileSync`s every one of ~1.800 files — ran ONCE PER BASELINE ENTRY,
    // so this one assertion did eight full repo scans and took ~7,6 s against
    // vitest's 5 s default. It failed as a TIMEOUT, which reads like a flake and
    // is not one: it is deterministic, it gets worse every time the repo grows
    // or the list does, and its sibling assertion above calls the same function
    // once and passes comfortably. Found while gating an unrelated change.
    const sites = handRolledSites();
    const stale = BASELINE.filter((f) => !sites.includes(f));
    expect(stale).toEqual([]);
  });

  it("keeps the two silent-loss escalations OFF the list", () => {
    // These are the ones where a padded recipient set suppressed the
    // empty-fan-out trace, so an escalation could reach nobody and leave no
    // evidence. They are migrated; this asserts they stay migrated.
    const sites = handRolledSites();
    expect(sites).not.toContain("src/modules/cases/application/escalate-stale-disputes.ts");
    expect(sites).not.toContain(
      "src/modules/cases/application/escalate-stale-decomiso-handoffs.ts",
    );
    expect(sites).not.toContain("lib/infra/approval-routing.ts");
  });
});
