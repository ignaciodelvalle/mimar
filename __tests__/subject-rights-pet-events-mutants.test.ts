// Mutants of the pet_events erasure rules, killed against the LIVE database
// (T3-A2b, design §5.6 — the style of subject-rights-0208-mutants.test.ts).
//
// Each mutation of the live rules or helpers is applied for real inside a
// rolled-back transaction, and observed as DATA:
//   A. one rule row dropped (incident_reported.injuries_summary): the victim's
//      injuries survive — and lint:subject-rights goes red.
//   B. the live bug re-introduced: a rule that sentinels
//      microchip_replaced.reason, the enum 0159-0228's key-name sweep
//      destroyed. 'damaged' is overwritten — and the fence and the migration's
//      own replay-time DO block refuse it.
//   C. the machine-code guard removed (security review item 1): the code
//      'return_to_original_owner' under status_changed.reason is destroyed —
//      and the fence reports the pattern drift.
//   D. adoption_reversed.reason author-gated again (item 2): the adopter's
//      erasure no longer reaches a shelter's words about them.
//   E. the per-kind rule for legacy info requests dropped (item 3): a legacy
//      info request survives in `text`.
// The unmutated live state is the control: the fence is clean on it.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { RedactionRule } from "@/lib/events/payload-privacy";
import { evaluateRedactionRules } from "@/scripts/check-subject-rights-coverage";

import {
  type Tx,
  eraseAs,
  inRolledBackTx,
  insertEvent,
  rows,
  seedPet,
  seedUser,
  snapshotEvents,
} from "./_helpers/erasure-tx";

async function liveRules(tx: Tx): Promise<RedactionRule[]> {
  return (await rows(
    tx,
    sql`SELECT event_type, key_path, transform, author_gated, party_keys
          FROM pii.pet_event_redaction_rules`,
  )) as unknown as RedactionRule[];
}

async function liveViolations(tx: Tx): Promise<string[]> {
  const [r] = await rows(
    tx,
    sql`SELECT pii.pet_event_kept_author_roles() AS kept,
               pii.pet_event_verified_author_roles() AS verified,
               pii.pet_event_code_pattern() AS code,
               pg_get_functiondef('public.erase_subject_data(uuid, text)'::regprocedure) AS def`,
  );
  return evaluateRedactionRules(await liveRules(tx), r?.kept as string[], r?.def as string, {
    codePattern: r?.code as string,
    verifiedRoles: r?.verified as string[],
    coordinateTypes: [],
  }).map((v) => v.kind);
}

/** PART D of the migration that seeded the rules — its replay-time assertions. */
function partDAssertions(): string {
  const dir = "db/migrations";
  const file = readdirSync(dir).find((f) => f.endsWith("_erasure_pet_events_by_key.sql"));
  if (!file) throw new Error("the pet_events erasure migration is missing");
  const src = readFileSync(join(dir, file), "utf8");
  const start = src.indexOf("do $$", src.indexOf("-- PART D"));
  const end = src.indexOf("end $$;", start) + "end $$;".length;
  if (start < 0 || end <= start) throw new Error("PART D do-block not found");
  return src.slice(start, end);
}

type Mutation =
  | "none"
  | "drop_injuries"
  | "sentinel_chip_reason"
  | "code_guard_removed"
  | "regate_reversal"
  | "drop_kind_rule";

const MUTATION_SQL: Record<Mutation, string | null> = {
  none: null,
  drop_injuries: `DELETE FROM pii.pet_event_redaction_rules
                   WHERE event_type = 'incident_reported' AND key_path = array['injuries_summary']`,
  sentinel_chip_reason: `INSERT INTO pii.pet_event_redaction_rules (event_type, key_path, transform, author_gated)
                         VALUES ('microchip_replaced', array['reason'], 'sentinel', false)`,
  code_guard_removed: `CREATE OR REPLACE FUNCTION pii.pet_event_code_pattern() RETURNS text
                         LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ select '^$'::text $$`,
  regate_reversal: `UPDATE pii.pet_event_redaction_rules SET author_gated = true
                     WHERE event_type = 'adoption_reversed' AND key_path = array['reason']`,
  drop_kind_rule: `DELETE FROM pii.pet_event_redaction_rules
                    WHERE event_type = 'note_added:adoption_info_requested'`,
};

type Probe = {
  violations: string[];
  payloads: Record<string, Record<string, unknown>>;
  doBlockError: string | null;
};

/** Seeds one row per mutant's subject matter, mutates, erases, reports. */
async function probe(mutation: Mutation): Promise<Probe> {
  return inRolledBackTx(async (tx) => {
    const S = await seedUser(tx, "a2b-mutant");
    const X = await seedUser(tx, "a2b-mutant-shelter");
    const pet = await seedPet(tx, S);
    const shelterPet = await seedPet(tx, X);
    const ids: Record<string, string> = {};
    const own = (eventType: string, payload: Record<string, unknown>) =>
      insertEvent(tx, { petId: pet, eventType, recordedByUserId: S, authorRole: "owner", payload });
    const shelter = (eventType: string, payload: Record<string, unknown>) =>
      insertEvent(tx, {
        petId: shelterPet,
        eventType,
        recordedByUserId: X,
        authorRole: "shelter",
        payload,
        extra: { authorVerified: true },
      });

    ids.bite = await own("incident_reported", {
      incident_type: "bite_inflicted",
      severity: "minor",
      injuries_summary: "Herida de Ana",
    });
    ids.chip = await own("microchip_replaced", {
      previous_chip_number: "985112000000009",
      new_chip_number: null,
      reason: "damaged",
    });
    ids.status = await own("status_changed", {
      from_status: "lost",
      to_status: "active",
      reason: "return_to_original_owner",
    });
    const application = await shelter("adoption_application_submitted", { applicant_user_id: S });
    const finalization = await shelter("adoption_finalized", { adopter_user_id: S });
    ids.reversal = await shelter("adoption_reversed", {
      actor: "shelter",
      reason: "Ana lo dejaba solo",
      reverted_finalization_event_id: finalization,
    });
    ids.legacyInfo = await shelter("note_added", {
      category: "system",
      text: "Ana, necesitamos ver tu casa",
      kind: "adoption_info_requested",
      application_event_id: application,
    });

    const m = MUTATION_SQL[mutation];
    if (m) await tx.execute(sql.raw(m));
    const violations = await liveViolations(tx);

    let doBlockError: string | null = null;
    await tx.execute(sql`SAVEPOINT part_d`);
    try {
      await tx.execute(sql.raw(partDAssertions()));
    } catch (err) {
      doBlockError = err instanceof Error ? err.message : String(err);
    }
    await tx.execute(sql`ROLLBACK TO SAVEPOINT part_d`);

    await eraseAs(tx, S);
    const snap = await snapshotEvents(tx, Object.values(ids));
    const payloads: Record<string, Record<string, unknown>> = {};
    for (const [k, id] of Object.entries(ids)) {
      payloads[k] = snap.find((r) => r.id === id)?.payload ?? {};
    }
    return { violations, payloads, doBlockError };
  });
}

describe("pet_events redaction rules — mutants killed against the live database", () => {
  const p: Partial<Record<Mutation, Probe>> = {};
  beforeAll(async () => {
    for (const m of Object.keys(MUTATION_SQL) as Mutation[]) p[m] = await probe(m);
  }, 180_000);
  const at = (m: Mutation) => p[m] as Probe;

  it("control: the live contract equals the classification and the erasure behaves", () => {
    const c = at("none");
    expect(c.violations).toEqual([]);
    expect(c.doBlockError).toBeNull();
    expect(c.payloads.bite?.injuries_summary).toBe("[dato removido]");
    expect(c.payloads.chip?.reason).toBe("damaged");
    expect(c.payloads.status?.reason).toBe("return_to_original_owner");
    expect(c.payloads.reversal?.reason).toBe("[dato removido]");
    expect(c.payloads.legacyInfo?.text).toBe("[dato removido]");
  });

  it("KILL A: dropping the injuries_summary rule leaves the victim's injuries — and the fence goes red", () => {
    expect(at("drop_injuries").payloads.bite?.injuries_summary).toBe("Herida de Ana");
    expect(at("drop_injuries").violations).toEqual(["redaction_rule_missing_in_db"]);
  });

  it("KILL B: a rule sentinelling microchip_replaced.reason destroys the enum — the fence and the DO block refuse it", () => {
    expect(at("sentinel_chip_reason").payloads.chip?.reason).toBe("[dato removido]");
    expect(at("sentinel_chip_reason").violations).toEqual(["redaction_rule_extra_in_db"]);
    expect(at("sentinel_chip_reason").doBlockError).toContain("a rule targets an enum reason");
  });

  it("KILL C: without the code guard the machine code is destroyed — the fence and the DO block see it", () => {
    expect(at("code_guard_removed").payloads.status?.reason).toBe("[dato removido]");
    expect(at("code_guard_removed").violations).toEqual(["code_pattern_differs"]);
    expect(at("code_guard_removed").doBlockError).toContain("does not separate codes from prose");
  });

  it("KILL D: author-gating adoption_reversed.reason lets a shelter's words about the adopter survive", () => {
    expect(at("regate_reversal").payloads.reversal?.reason).toBe("Ana lo dejaba solo");
    expect(at("regate_reversal").violations).toEqual(["redaction_rule_differs"]);
  });

  it("KILL E: without the per-kind rule a legacy info request survives in text", () => {
    expect(at("drop_kind_rule").payloads.legacyInfo?.text).toBe("Ana, necesitamos ver tu casa");
    expect(at("drop_kind_rule").violations).toEqual(["redaction_rule_missing_in_db"]);
  });
});
