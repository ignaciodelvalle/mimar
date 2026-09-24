/**
 * Self-tests for scripts/check-titular-gate.ts — the titular-only write fence.
 *
 * A fence whose own controls pass vacuously is worse than no fence: it buys
 * false confidence. So every control below was proven to FAIL before the
 * checker existed, and three of them are adversarial by construction:
 *
 *   1. POSITIVE   — a synthetic ungated `custody_transferred` writer must be
 *                   reported. Goes red the day the detection regex stops
 *                   matching (the "fence enumerates forms, not the thing"
 *                   failure mode).
 *   2. NEGATIVE   — the same source with the guard present must be clean, so a
 *                   green run means "gated", not "unscannable".
 *   3. COMMENTS   — a guard named ONLY inside a comment must still be an
 *                   offender. This is the 2026-08-09 `stripComments` hole that
 *                   bit check-db-budget: a substring test rewarded DOCUMENTING
 *                   the rule with an exemption from it.
 *   4. COVERAGE   — the deny-list constants may not be emptied to turn a red
 *                   build green, and every event type named there must be a
 *                   real member of EVENT_TYPES.
 *
 * Pure fixtures (no filesystem I/O) plus one assertion against the REAL tree,
 * so the guard is proven on the current codebase and not only on synthetics.
 */

import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "../db/schema";
import {
  TITULAR_ONLY_DENY_LIST,
  TITULAR_ONLY_EVENT_TYPES,
  TITULAR_ONLY_INSERT_TABLES,
  TITULAR_ONLY_PET_COLUMNS,
  isTitularOnlyEventType,
} from "../lib/domain/titular-only";
import {
  TITULAR_GATE_ALLOWLIST,
  findTitularGateOffenders,
  indexTitularEffects,
  listScanSources,
} from "../scripts/check-titular-gate";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNGATED_EVENT_WRITER = `"use server";

import { db, petEvents } from "@/db";
import { requirePetAccess } from "@/lib/infra/pet-access";

export async function forgeCustodyAction(publicToken: string): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return;
  await db.insert(petEvents).values({
    petId: access.pet.id,
    eventType: "custody_transferred",
  });
}
`;

const GATED_EVENT_WRITER = `"use server";

import { db, petEvents } from "@/db";
import { requireTitularAccess } from "@/lib/infra/pet-access";

export async function forgeCustodyAction(publicToken: string): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return;
  const titular = await requireTitularAccess(publicToken);
  if (!titular.ok) return;
  await db.insert(petEvents).values({
    petId: access.pet.id,
    eventType: "custody_transferred",
  });
}
`;

const GUARD_ONLY_IN_A_COMMENT = `"use server";

import { db, petEvents } from "@/db";
import { requirePetAccess } from "@/lib/infra/pet-access";

export async function forgeCustodyAction(publicToken: string): Promise<void> {
  // Safe: the caller already went through requireTitularAccess(publicToken).
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return;
  await db.insert(petEvents).values({
    petId: access.pet.id,
    eventType: "custody_transferred",
  });
}
`;

const UNGATED_COLUMN_WRITER = `"use server";

import { db, pets } from "@/db";
import { requirePetAccess } from "@/lib/infra/pet-access";

export async function moveJurisdictionAction(publicToken: string): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return;
  await db.update(pets).set({ jurisdictionProvince: "Buenos Aires" });
}
`;

const ORG_PATH_EVENT_WRITER = `"use server";

import { db, petEvents } from "@/db";
import { requireCapabilityForOrgToken } from "@/lib/auth-guards";

export async function orgTransferAction(orgToken: string): Promise<void> {
  const auth = await requireCapabilityForOrgToken("custody.transfer", orgToken);
  await db.insert(petEvents).values({
    petId: auth.petId,
    eventType: "custody_transferred",
  });
}
`;

const DELEGATING_USE_CASE = `import { db, pets } from "@/db";

export async function setTier2Window(petId: string): Promise<void> {
  await db.update(pets).set({ tier2PublicEnabledUntil: new Date() });
}
`;

const DELEGATING_ACTION = `"use server";

import { requirePetAccess } from "@/lib/infra/pet-access";
import { setTier2Window } from "@/src/modules/pets/application/tier2-public/set-tier2-window";

export async function enableTier2Action(publicToken: string): Promise<void> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return;
  await setTier2Window(access.pet.id);
}
`;

const source = (relPath: string, src: string) => ({ relPath, src });

// ---------------------------------------------------------------------------
// Control 1 — positive
// ---------------------------------------------------------------------------

describe("check-titular-gate — positive control", () => {
  it("reports an ungated titular-only event writer", () => {
    const offenders = findTitularGateOffenders([
      source("app/actions/synthetic.ts", UNGATED_EVENT_WRITER),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("forgeCustodyAction");
    expect(offenders[0]).toContain("custody_transferred");
  });

  it("reports an ungated titular-only pets column write", () => {
    const offenders = findTitularGateOffenders([
      source("app/actions/synthetic.ts", UNGATED_COLUMN_WRITER),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("moveJurisdictionAction");
    expect(offenders[0]).toContain("jurisdictionProvince");
  });

  it("follows delegation: an action whose effect lives in a use-case is still reported", () => {
    // THE shape that matters in this codebase — the guard is in the action and
    // the write is in the use-case, so a function-local rule would see nothing.
    const offenders = findTitularGateOffenders([
      source("src/modules/pets/application/tier2-public/set-tier2-window.ts", DELEGATING_USE_CASE),
      source("app/actions/tier2.ts", DELEGATING_ACTION),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("enableTier2Action");
  });
});

// ---------------------------------------------------------------------------
// Control 2 — negative
// ---------------------------------------------------------------------------

describe("check-titular-gate — negative control", () => {
  it("accepts the same writer once it calls requireTitularAccess", () => {
    expect(
      findTitularGateOffenders([source("app/actions/synthetic.ts", GATED_EVENT_WRITER)]),
    ).toEqual([]);
  });

  it("ignores an org-path writer — the caretaker never reaches it", () => {
    // holderRole is null on the org path by construction (design decision B), so
    // requireTitularAccess would be a no-op there. Flagging it would flood the
    // baseline with every legitimate shelter action.
    expect(
      findTitularGateOffenders([source("src/modules/transfers/actions.ts", ORG_PATH_EVENT_WRITER)]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Control 3 — comment stripping
// ---------------------------------------------------------------------------

describe("check-titular-gate — comment-stripping control", () => {
  it("does NOT accept a guard named only inside a comment", () => {
    const offenders = findTitularGateOffenders([
      source("app/actions/synthetic.ts", GUARD_ONLY_IN_A_COMMENT),
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("forgeCustodyAction");
  });
});

// ---------------------------------------------------------------------------
// Control 4 — coverage / anti-emptying
// ---------------------------------------------------------------------------

describe("titular-only constants — coverage", () => {
  it("every titular-only event type is a real member of EVENT_TYPES", () => {
    const known = new Set<string>(EVENT_TYPES);
    for (const eventType of TITULAR_ONLY_EVENT_TYPES) {
      expect(known.has(eventType), `${eventType} is not in EVENT_TYPES`).toBe(true);
    }
  });

  it("keeps all seven spec deny-list rows", () => {
    expect(TITULAR_ONLY_DENY_LIST.length).toBeGreaterThanOrEqual(7);
    expect(
      TITULAR_ONLY_EVENT_TYPES.length +
        TITULAR_ONLY_PET_COLUMNS.length +
        TITULAR_ONLY_INSERT_TABLES.length,
    ).toBeGreaterThanOrEqual(TITULAR_ONLY_DENY_LIST.length);
  });

  it("backs every deny-list row with real signals, or says out loud that it does not", () => {
    // THE anti-vacuity assertion. Emptying any of the three constants to turn a
    // red build green now breaks the deny-list rows that referenced them,
    // instead of silently shrinking the fence's subject to nothing.
    const declared = new Set<string>([
      ...TITULAR_ONLY_EVENT_TYPES,
      ...TITULAR_ONLY_PET_COLUMNS,
      ...TITULAR_ONLY_INSERT_TABLES,
    ]);
    for (const row of TITULAR_ONLY_DENY_LIST) {
      for (const signal of row.signals) {
        expect(declared.has(signal), `${row.id} names an unknown signal "${signal}"`).toBe(true);
      }
      if (row.signals.length === 0) {
        expect(row.pending, `${row.id} has no signal and no pending reason`).not.toBeNull();
        expect((row.pending ?? "").length).toBeGreaterThan(40);
      } else {
        expect(row.pending, `${row.id} has signals AND a pending reason`).toBeNull();
      }
    }
    // RATCHET. This was `toHaveLength(1)` while `caretaker-sub-designation`
    // waited for the event type to exist (C1 → C5). The caretakers module ships
    // `caretaker_designated`, so the row now carries a real signal and NO row
    // may be knowingly unenforced. Going back up to 1 is a regression that has
    // to be argued for in a diff, not a state anyone can drift into.
    expect(TITULAR_ONLY_DENY_LIST.filter((r) => r.pending !== null)).toHaveLength(0);
  });

  it("denies caretaker sub-designation through the event type, not through a promise", () => {
    // The whole point of the deny-list row: a caretaker must not be able to
    // name another caretaker. The ONLY legitimate writer of this event type is
    // the invitee accepting their own invitation, which is exempted by an
    // inner-writer suffix on the repository method — see
    // src/modules/caretakers/infrastructure/caretakers-repository.ts.
    expect(isTitularOnlyEventType("caretaker_designated")).toBe(true);

    const row = TITULAR_ONLY_DENY_LIST.find((r) => r.id === "caretaker-sub-designation");
    expect(row?.signals).toContain("caretaker_designated");
    expect(row?.pending).toBeNull();
  });

  it("does NOT deny caretaker_ended — ending an arrangement is not designating one", () => {
    // A caretaker withdrawing from their own arrangement is legitimate (spec:
    // "Caretaker account deactivation ends the grant"), and the cron writes it
    // with no user at all. Adding it to the constant would deny both.
    expect(isTitularOnlyEventType("caretaker_ended")).toBe(false);
  });

  it("isTitularOnlyEventType agrees with the constant", () => {
    expect(isTitularOnlyEventType("custody_transferred")).toBe(true);
    expect(isTitularOnlyEventType("vaccination_administered")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real tree — the fence is proven on the current codebase, not only fixtures
// ---------------------------------------------------------------------------

describe("check-titular-gate — real tree", () => {
  it("finds titular-only effects in the real codebase (detection is not vacuous)", () => {
    const effects = indexTitularEffects(listScanSources());
    expect(effects.size).toBeGreaterThan(0);
    // The jurisdiction writer is the canonical example: a real, non-synthetic
    // titular-only column write that the index must see.
    expect([...effects.keys()]).toContain("recordMovementWriter");
  });

  it("has no offender outside the documented allowlist", () => {
    const offenders = findTitularGateOffenders(listScanSources());
    expect(offenders).toEqual([]);
  });

  it("sees THROUGH the caretakers repository port — the blind spot found in C5", () => {
    // MEASURED FAILURE, pinned so it cannot recur silently.
    //
    // The index propagates "reaches a titular-only effect" along call edges
    // matched BY NAME. The caretakers module is the first to put a declared
    // PORT between the use-case and the repository: the use-case calls
    // `repo.insertAcceptGrant(...)`, the port's name. While the concrete method
    // was called `insertAcceptGrantForToken`, the effect was indexed on that
    // name, nothing in the tree called it, and the taint stopped dead at the
    // repository — the whole accept chain was invisible while the fence
    // reported itself clean.
    //
    // Renaming the concrete method to equal the port method restored the edge.
    // This assertion is what makes that a rule instead of a coincidence: rename
    // one side and the propagation stops, and this goes red.
    const effects = indexTitularEffects(listScanSources());
    const keys = [...effects.keys()];

    expect(keys, "the accept writer must be indexed").toContain("insertAcceptGrant");
    expect(
      keys,
      "the taint must reach the use-case through the port name, not stop at the repository",
    ).toContain("acceptCaretakerGrant");
    expect(effects.get("acceptCaretakerGrant")).toContain("event:caretaker_designated");
  });

  it("every allowlist entry carries a reason", () => {
    for (const [key, reason] of Object.entries(TITULAR_GATE_ALLOWLIST)) {
      expect(reason.length, `${key} has an empty reason`).toBeGreaterThan(20);
    }
  });

  it("keeps the allowlist EMPTY", () => {
    // The ratchet. The fence shipped with five entries and the guard swaps
    // emptied it; from here on, adding one is a deliberate act that has to
    // change this test too, instead of a quiet way to make a red build green.
    expect(Object.keys(TITULAR_GATE_ALLOWLIST)).toEqual([]);
  });
});
