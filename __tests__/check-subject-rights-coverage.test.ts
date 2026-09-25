// Unit tests for the subject-rights coverage fence (pnpm lint:subject-rights).
//
// The fence's whole value is that it fails. A classification file that only
// ever prints a green line is indistinguishable from one whose checks are
// vacuous — this repo has been bitten by exactly that (the content-report
// exemption list said "four" while the code had twelve), so the five checks are
// each shown FIRING here, against lists derived from the fence itself rather
// than retyped. If these lists are ever copied into this file instead of
// imported, the test stops testing the fence and starts testing a snapshot.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CODE_PATTERN, KEPT_AUTHOR_ROLES, redactionRules } from "@/lib/events/payload-privacy";
import {
  BUCKETS_ERASED,
  BUCKETS_KNOWN_GAP,
  CLASSIFICATION,
  type Classification,
  ERASURE_STORAGE_SOURCE,
  EXEMPT,
  IN_ERASE,
  IN_EXPORT,
  KNOWN_GAP,
  PET_EVENT_REDACTION_HELPERS,
  bodyMentions,
  bucketsNamedIn,
  evaluate,
  evaluateBuckets,
  evaluateRedactionExtras,
  evaluateRedactionRules,
  sideGaps,
} from "@/scripts/check-subject-rights-coverage";

/** Every table the fence declares, derived — never a second copy of the set. */
const ALL_DECLARED: string[] = Object.keys(CLASSIFICATION);

/** A synthetic function body naming exactly the tables it is handed. */
function bodyNaming(tables: readonly string[]): string {
  return tables.map((t) => `SELECT 1 FROM public.${t} WHERE x = 1;`).join("\n");
}

const FULL_EXPORT_BODY = bodyNaming(IN_EXPORT);
const FULL_ERASE_BODY = bodyNaming(IN_ERASE);

describe("bodyMentions", () => {
  it("matches a schema-qualified reference and not a bare or partial one", () => {
    expect(bodyMentions("FROM public.pet_events ev", "pet_events")).toBe(true);
    // Unqualified: both RPCs schema-qualify, and a bare word would collide with
    // a column, an alias or a comment.
    expect(bodyMentions("FROM pet_events ev", "pet_events")).toBe(false);
    // A longer table name must not satisfy a shorter one's check.
    expect(bodyMentions("FROM public.pet_events_archive a", "pet_events")).toBe(false);
    expect(bodyMentions("FROM public.pet_caretaker_grants g", "pet_tags")).toBe(false);
  });
});

describe("evaluate — the declared lists agree with themselves", () => {
  it("passes when every declared table is live and both bodies name what they claim", () => {
    const { violations } = evaluate(ALL_DECLARED, FULL_EXPORT_BODY, FULL_ERASE_BODY);
    expect(violations).toEqual([]);
  });

  it("no table is in both a covered list and an uncovered one", () => {
    const uncovered = new Set([...Object.keys(EXEMPT), ...Object.keys(KNOWN_GAP)]);
    for (const t of [...IN_EXPORT, ...IN_ERASE]) {
      expect(uncovered.has(t)).toBe(false);
    }
  });

  it("no table is both EXEMPT and KNOWN_GAP", () => {
    for (const t of Object.keys(EXEMPT)) {
      expect(Object.hasOwn(KNOWN_GAP, t)).toBe(false);
    }
  });

  it("every EXEMPT and KNOWN_GAP entry carries a written reason", () => {
    for (const [table, reason] of [...Object.entries(EXEMPT), ...Object.entries(KNOWN_GAP)]) {
      expect(reason.trim().length, `${table} has an empty reason`).toBeGreaterThan(20);
    }
  });
});

describe("evaluate — each check actually fires", () => {
  it("CHECK 1: a new public table in no list is a violation", () => {
    const { violations } = evaluate(
      [...ALL_DECLARED, "some_new_pii_table"],
      FULL_EXPORT_BODY,
      FULL_ERASE_BODY,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unclassified");
    expect(violations[0].message).toContain("some_new_pii_table");
  });

  it("CHECK 2: a declared table that no longer exists is a violation", () => {
    const withoutOne = ALL_DECLARED.filter((t) => t !== "foster_volunteers");
    const { violations } = evaluate(withoutOne, FULL_EXPORT_BODY, FULL_ERASE_BODY);
    // One classification entry, so one stale violation — no longer one per list.
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("stale");
    expect(violations[0].message).toContain("foster_volunteers");
  });

  it("CHECK 3 (forward): a declared table missing from the LIVE body is a violation", () => {
    // The regression this exists for: a future CREATE OR REPLACE that drops a
    // section. The declaration still says the table is covered; the database
    // says otherwise, and the database wins.
    const bodyWithoutGrants = bodyNaming(IN_EXPORT.filter((t) => t !== "pet_caretaker_grants"));
    const { violations } = evaluate(ALL_DECLARED, bodyWithoutGrants, FULL_ERASE_BODY);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("missing_from_function");
    expect(violations[0].message).toContain("pet_caretaker_grants");
    expect(violations[0].message).toContain("export_subject_data");
  });

  it("CHECK 4 (reverse): a KNOWN_GAP table the body DOES name is a violation", () => {
    // Closing a gap is a one-way door: you cannot add a table to a function and
    // leave it sitting in the debt register, where it would still be counted as
    // outstanding work and reported as such on every run.
    const gapTable = Object.keys(KNOWN_GAP)[0];
    const { violations } = evaluate(
      ALL_DECLARED,
      `${FULL_EXPORT_BODY}\nSELECT 1 FROM public.${gapTable};`,
      FULL_ERASE_BODY,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("covered_but_listed_uncovered");
    expect(violations[0].message).toContain(gapTable);
  });

  it("CHECK 4 (reverse) fires for an exempt side too, and names the state", () => {
    const { violations } = evaluate(
      ALL_DECLARED,
      FULL_EXPORT_BODY,
      `${FULL_ERASE_BODY}\nDELETE FROM public.cron_runs;`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("exempt");
    expect(violations[0].message).toContain("erase_subject_data");
  });
});

// A05-2. The fence used to classify TABLES, so a table one RPC named was
// "covered" and its missing half had nowhere to be written. These show the
// per-side machinery firing, each against a single side.
describe("evaluate — each SIDE is classified and checked on its own", () => {
  it("CHECK 4 is per side: naming an export-only table in the ERASE body fires", () => {
    // organization_memberships: export covered, erase gap (ERRATA #2). Under the
    // table-level design this mention was invisible — the table was "covered".
    const { violations } = evaluate(
      ALL_DECLARED,
      FULL_EXPORT_BODY,
      `${FULL_ERASE_BODY}\nUPDATE public.organization_memberships SET title = NULL;`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("covered_but_listed_uncovered");
    expect(violations[0].message).toContain("organization_memberships");
    expect(violations[0].message).toContain("erase side is declared gap");
  });

  it("CHECK 1: a side that is not stated is a violation, not a default", () => {
    const broken = {
      ...CLASSIFICATION,
      pets: { export: { state: "covered" } } as unknown as Classification,
    };
    const { violations } = evaluate(ALL_DECLARED, FULL_EXPORT_BODY, FULL_ERASE_BODY, broken);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unclassified_side");
    expect(violations[0].message).toContain("pets");
    expect(violations[0].message).toContain("erase side is not stated");
  });

  it("CHECK 1: a non-covered side with no written reason is a violation", () => {
    const broken: Record<string, Classification> = {
      ...CLASSIFICATION,
      reminders: {
        export: { state: "gap", reason: "todo" },
        erase: CLASSIFICATION.reminders.erase,
      },
    };
    const { violations } = evaluate(ALL_DECLARED, FULL_EXPORT_BODY, FULL_ERASE_BODY, broken);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("unreasoned_side");
    expect(violations[0].message).toContain("reminders");
  });

  it("CHECK 5: a covered_outside_sql side whose function is gone is a violation", () => {
    // The erasure module loses its functions — the rename that would otherwise
    // leave the "TypeScript reaches it" claim standing as a bare sentence.
    const readSource = (p: string) => (p.endsWith("erase-subject-data.ts") ? "// empty\n" : null);
    const { violations } = evaluate(
      ALL_DECLARED,
      FULL_EXPORT_BODY,
      FULL_ERASE_BODY,
      CLASSIFICATION,
      readSource,
    );
    expect(violations.map((v) => v.kind)).toEqual([
      "outside_sql_site_missing",
      "outside_sql_site_missing",
    ]);
    expect(violations.map((v) => v.message).join("\n")).toContain("purgeOwnedPetAttachments");
    expect(violations.map((v) => v.message).join("\n")).toContain("releaseMicrochipsForErasedPets");
  });

  it("CHECK 5 reads the real module: both named erasure steps exist today", () => {
    const { violations } = evaluate(ALL_DECLARED, FULL_EXPORT_BODY, FULL_ERASE_BODY);
    expect(violations.filter((v) => v.kind === "outside_sql_site_missing")).toEqual([]);
  });
});

describe("the one-sided debt is written down, and pinned", () => {
  // Stated by hand, not derived: these are the halves A05-2 found missing. A new
  // one-sided gap, or one closed, turns this red so the change is seen in a diff.
  const EXPORT_SIDE_GAPS_OUTSIDE_KNOWN_GAP = [
    "attachments",
    "case_events",
    // 0250: a projection of pet_events.payload->place; the export returns the
    // events themselves, place included, but not this index as its own section.
    "event_places",
    "libreta_share_tokens",
    "notification_dead_letter",
  ];
  const ERASE_SIDE_GAPS_OUTSIDE_KNOWN_GAP = ["organization_memberships"];

  it("lists exactly the tables whose art. 14 side alone is a gap", () => {
    const got = sideGaps().export.filter((t) => !Object.hasOwn(KNOWN_GAP, t));
    expect(got).toEqual(EXPORT_SIDE_GAPS_OUTSIDE_KNOWN_GAP);
  });

  it("lists exactly the tables whose art. 16 side alone is a gap", () => {
    const got = sideGaps().erase.filter((t) => !Object.hasOwn(KNOWN_GAP, t));
    expect(got).toEqual(ERASE_SIDE_GAPS_OUTSIDE_KNOWN_GAP);
  });

  it("attachments is no longer EXEMPT: it names the uploader and holds their caption", () => {
    expect(Object.hasOwn(EXEMPT, "attachments")).toBe(false);
    expect(CLASSIFICATION.attachments.export.state).toBe("gap");
    expect(CLASSIFICATION.attachments.erase.state).toBe("covered_outside_sql");
  });

  // 0251 added place_repair_preimages (row ids, catalogue ids, a verdict).
  it("EXEMPT holds fifteen tables, every one exempt on BOTH sides", () => {
    expect(Object.keys(EXEMPT)).toHaveLength(15);
    for (const t of Object.keys(EXEMPT)) {
      expect(CLASSIFICATION[t].export.state, t).toBe("exempt");
      expect(CLASSIFICATION[t].erase.state, t).toBe("exempt");
    }
  });
});

describe("the debt register is not empty, says so, and may not grow quietly", () => {
  it("reports the KNOWN_GAP count, so shrinking it is measurable", () => {
    const { gapCount } = evaluate(ALL_DECLARED, FULL_EXPORT_BODY, FULL_ERASE_BODY);
    expect(gapCount).toBe(Object.keys(KNOWN_GAP).length);
    // Not an assertion about the NUMBER — that should fall over time. It is an
    // assertion that the channel carries a real value: a gapCount hard-wired to
    // zero would read as "no debt" on a run that never looked.
    expect(gapCount).toBeGreaterThan(0);
  });

  // THE RATCHET. Without it, "we know about these 21" degrades into 40 one
  // reviewed diff at a time: KNOWN_GAP is the one escape hatch in the fence, and
  // an escape hatch with no ceiling is just a slower way of not having a fence.
  // A new PII table must be added to a subject-rights RPC, or land here with the
  // ceiling raised BY HAND in the same commit — which is the moment somebody has
  // to justify it in a diff instead of appending a line.
  // 0207 moved libreta_share_tokens out of the register (erase now revokes
  // the subject's outstanding shares), so the ceiling ratchets 21 -> 20.
  // 0208 moved out operator_feed_watermarks (deleted), physical_tag_interest
  // (deleted) and organization_invitations (email sentinelled + outstanding
  // invitations revoked; the actor FKs and accepted rows kept as the access
  // trail), so it ratchets 20 -> 17.
  // 0226 moved out notification_dead_letter (every dead letter addressed to the
  // subject loses its payload and is resolved), so it ratchets 17 -> 16.
  // 0250 added place_resolutions: append-only, so erasure cannot anonymise the
  // admin actor or the reason they typed in place. Raised 16 -> 17 on purpose.
  const KNOWN_GAP_CEILING = 17;

  it("does not grow past the declared ceiling without someone raising it on purpose", () => {
    expect(
      Object.keys(KNOWN_GAP).length,
      `KNOWN_GAP grew past ${KNOWN_GAP_CEILING}. Reach the table from export_subject_data / erase_subject_data instead — or raise KNOWN_GAP_CEILING in this test, in the same commit, with the reason in the commit body.`,
    ).toBeLessThanOrEqual(KNOWN_GAP_CEILING);
  });

  it("ratchets DOWN: closing a gap must lower the ceiling, so it cannot be re-spent", () => {
    // The other half, and the one that makes this a ratchet rather than a cap.
    // Without it, closing five gaps would leave five free slots for the next
    // five tables to occupy silently.
    expect(
      Object.keys(KNOWN_GAP).length,
      `KNOWN_GAP shrank below ${KNOWN_GAP_CEILING} — good. Lower KNOWN_GAP_CEILING to match, so the slots you just freed cannot be silently refilled.`,
    ).toBeGreaterThanOrEqual(KNOWN_GAP_CEILING);
  });
});

// The sin the fence's own header names, turned into a check instead of a
// paragraph: "`push_subscriptions` was DELETED by art. 16 while art. 14 never
// returned it, so the subject could not see what was about to be destroyed."
// Nothing enforced that. A table can still be added to erase_subject_data alone
// and the four catalogue checks all pass — the fence asks whether each table is
// CLASSIFIED, never whether the two rights agree with each other.
describe("art. 16 may not reach further than art. 14", () => {
  // The three tables where erase reaches and export does not, TODAY. Frozen by
  // hand for the same reason KNOWN_GAP_CEILING is: an exception list with no
  // ceiling is not an exception list.
  //
  //  · case_events — erase redacts the subject's own reporter_comment notes
  //    (0130); the export has never returned a case_events section.
  //  · libreta_share_tokens — 0207 revokes the subject's outstanding shares and
  //    says so in the fence itself: "The art. 14 side is still a gap —
  //    export_subject_data does not return the `label` the user typed."
  //  · notification_dead_letter — 0226 redacts the payload of every dead
  //    letter addressed to the subject; the export has never returned
  //    undelivered notifications (the fence says so beside the entry).
  const ERASE_ONLY_KNOWN: readonly string[] = [
    "case_events",
    "libreta_share_tokens",
    "notification_dead_letter",
  ];

  it("every table erase_subject_data reaches is also returned by export_subject_data", () => {
    const inExport = new Set(IN_EXPORT);
    const allowed = new Set(ERASE_ONLY_KNOWN);
    const undisclosed = IN_ERASE.filter((t) => !inExport.has(t) && !allowed.has(t));
    expect(
      undisclosed,
      `${undisclosed.join(", ")} — erase_subject_data destroys or rewrites these and export_subject_data never shows them, so the subject cannot see what art. 16 is about to do. Add a section to the export, or declare it in ERASE_ONLY_KNOWN with the reason.`,
    ).toEqual([]);
  });

  it("the exception list has no stale entry, so closing one of them frees nothing", () => {
    // The down-ratchet for this list. Without it, giving case_events an export
    // section would leave a free slot another table could quietly occupy.
    const inExport = new Set(IN_EXPORT);
    const inErase = new Set(IN_ERASE);
    for (const t of ERASE_ONLY_KNOWN) {
      expect(inErase.has(t), `${t} is in ERASE_ONLY_KNOWN but not in IN_ERASE`).toBe(true);
      expect(
        inExport.has(t),
        `${t} is now in IN_EXPORT — the art. 14 side was closed. Remove it from ERASE_ONLY_KNOWN in the same commit.`,
      ).toBe(false);
    }
  });
});

// Migration 0208. These three left KNOWN_GAP together; this is the regression
// guard that they left it in BOTH directions rather than only the cheap one.
describe("the three gaps migration 0208 closed", () => {
  const CLOSED_BY_0208 = [
    "operator_feed_watermarks",
    "physical_tag_interest",
    "organization_invitations",
  ] as const;

  it.each(CLOSED_BY_0208)(
    "%s is reached by BOTH rights, and is no longer declared as debt",
    (t) => {
      expect(IN_EXPORT, `${t} must be returned by export_subject_data (art. 14)`).toContain(t);
      expect(IN_ERASE, `${t} must be reached by erase_subject_data (art. 16)`).toContain(t);
      expect(Object.hasOwn(KNOWN_GAP, t), `${t} is still in the debt register`).toBe(false);
      expect(Object.hasOwn(EXEMPT, t), `${t} holds subject data — it is not EXEMPT`).toBe(false);
    },
  );
});

// A07-3: Storage is the half of the subject's data SQL cannot reach, so the
// bucket inventory is checked against the TypeScript that deletes objects.
describe("storage bucket inventory", () => {
  const ERASURE_SOURCE = readFileSync(ERASURE_STORAGE_SOURCE, "utf8");

  it("reads only string-literal .from() calls as buckets", () => {
    const named = bucketsNamedIn(
      `db.select().from(ownerships);
admin.storage.from("avatars").list();
admin.storage.from('x-y').remove(p);`,
    );
    expect([...named].sort()).toEqual(["avatars", "x-y"]);
  });

  it("the erasure module reaches exactly the four buckets it is declared to reach", () => {
    expect([...bucketsNamedIn(ERASURE_SOURCE)].sort()).toEqual([
      "avatars",
      "event-attachments",
      "pet-photos",
      "uploads-staging",
    ]);
    expect(evaluateBuckets([], ERASURE_SOURCE)).toEqual([]);
  });

  it("fails a live bucket that is in no list", () => {
    const kinds = evaluateBuckets(["avatars", "brand-new-bucket"], ERASURE_SOURCE).map(
      (v) => v.kind,
    );
    expect(kinds).toEqual(["bucket_unclassified"]);
  });

  it("fails when a declared sweep disappears from the erasure module", () => {
    const withoutAvatars = ERASURE_SOURCE.replaceAll('.from("avatars")', ".from(AVATARS)");
    expect(evaluateBuckets([], withoutAvatars).map((v) => v.kind)).toEqual(["bucket_not_erased"]);
  });

  it("fails when the erasure deletes from a bucket nobody declared", () => {
    const extra = `${ERASURE_SOURCE}
admin.storage.from("revocations").remove(paths);`;
    expect(evaluateBuckets([], extra).map((v) => v.kind)).toEqual(["bucket_erased_but_undeclared"]);
  });

  it("records the three evidence buckets as gaps — no retention decision is documented", () => {
    expect(Object.keys(BUCKETS_KNOWN_GAP)).toEqual(
      expect.arrayContaining(["revocations", "welfare-evidence", "decomiso-evidence"]),
    );
    expect(BUCKETS_ERASED).not.toContain("revocations");
    expect(BUCKETS_ERASED).not.toContain("welfare-evidence");
    expect(BUCKETS_ERASED).not.toContain("decomiso-evidence");
  });
});

// ---------------------------------------------------------------------------
// T3-A2b — the live pet_events redaction rules equal the TypeScript classification.
// ---------------------------------------------------------------------------

describe("evaluateRedactionRules — the rules table and the classification agree both ways", () => {
  const expected = redactionRules();
  const HELPER_CALLS = PET_EVENT_REDACTION_HELPERS.map((h) => `${h}(x)`).join("\n");
  const kept = [...KEPT_AUTHOR_ROLES];

  it("is clean when the live table equals redactionRules() and the body calls every helper", () => {
    expect(evaluateRedactionRules(expected, kept, HELPER_CALLS)).toEqual([]);
  });

  it("fails when the table is absent", () => {
    expect(evaluateRedactionRules(null, kept, HELPER_CALLS).map((v) => v.kind)).toEqual([
      "redaction_rules_missing",
    ]);
  });

  it("MUTANT: one rule row dropped from the live table goes red", () => {
    const dropped = expected.filter(
      (r) => !(r.event_type === "incident_reported" && r.key_path.join(".") === "injuries_summary"),
    );
    expect(dropped.length).toBe(expected.length - 1);
    const v = evaluateRedactionRules(dropped, kept, HELPER_CALLS);
    expect(v.map((x) => x.kind)).toEqual(["redaction_rule_missing_in_db"]);
    expect(v[0]?.message).toContain("incident_reported|injuries_summary");
  });

  it("MUTANT: a live rule that sentinels microchip_replaced.reason goes red as extra", () => {
    const withBug = [
      ...expected,
      {
        event_type: "microchip_replaced",
        key_path: ["reason"],
        transform: "sentinel" as const,
        author_gated: false,
        party_keys: null,
      },
    ];
    expect(evaluateRedactionRules(withBug, kept, HELPER_CALLS).map((v) => v.kind)).toEqual([
      "redaction_rule_extra_in_db",
    ]);
  });

  it("MUTANT: a rule whose gate or transform changed goes red", () => {
    const flipped = expected.map((r) =>
      r.event_type === "vet_visit_logged" && r.key_path[0] === "diagnosis"
        ? { ...r, author_gated: false }
        : r,
    );
    expect(evaluateRedactionRules(flipped, kept, HELPER_CALLS).map((v) => v.kind)).toEqual([
      "redaction_rule_differs",
    ]);
  });

  it("fails when the kept roles drift or the body stops calling a helper", () => {
    expect(
      evaluateRedactionRules(expected, [...kept, "owner"], HELPER_CALLS).map((v) => v.kind),
    ).toEqual(["kept_roles_differ"]);
    const noNotes = HELPER_CALLS.replace("pii.redacted_notes(x)", "");
    expect(evaluateRedactionRules(expected, kept, noNotes).map((v) => v.kind)).toEqual([
      "redaction_helper_not_called",
    ]);
  });
});

describe("evaluateRedactionExtras — code pattern, verified roles, coordinates fail closed", () => {
  const ok = { codePattern: CODE_PATTERN, verifiedRoles: ["shelter"], coordinateTypes: [] };

  it("is clean on the expected values and a classified coordinate type", () => {
    expect(evaluateRedactionExtras({ ...ok, coordinateTypes: ["incident_reported"] })).toEqual([]);
  });

  it("MUTANT: a drifted code pattern, verified roles, or an unclassified point type goes red", () => {
    expect(evaluateRedactionExtras({ ...ok, codePattern: "^$" }).map((v) => v.kind)).toEqual([
      "code_pattern_differs",
    ]);
    expect(evaluateRedactionExtras({ ...ok, verifiedRoles: [] }).map((v) => v.kind)).toEqual([
      "verified_roles_differ",
    ]);
    expect(
      evaluateRedactionExtras({ ...ok, coordinateTypes: ["brand_new_event"] }).map((v) => v.kind),
    ).toEqual(["coordinate_type_unclassified"]);
  });
});
