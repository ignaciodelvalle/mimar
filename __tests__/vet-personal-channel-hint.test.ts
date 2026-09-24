// The professional-channel hint — T4-I1 / issue #757.
//
// TWO QUESTIONS, AND ONLY THE SECOND ONE NEEDS A RUNTIME
// ---------------------------------------------------------------------------
// 1. Does the component decide correctly? That is a pure question about two
//    conditions (person path, validated matrícula) and is answered below by
//    calling it.
// 2. Is it actually ON the forms? That is the question that matters more, and
//    it cannot be answered by testing the component: a hint nobody renders
//    passes every unit test it has. The defect #757 reports is a person
//    discovering the attribution AFTER submitting, and "the author of the next
//    clinical form forgot the hint" reproduces it exactly — so the list of
//    slugs lives next to the component (VET_HINT_CAPTURE_SLUGS) and this file
//    reads each page's source and insists.
//
// A SOURCE SCAN and not a render, for the reason the repo's other page-level
// parity tests give: these are RSCs whose bodies open database sessions and
// resolve business rules, and standing all of that up per page would test the
// harness. What is being asserted is a WIRING fact, and the source is where a
// wiring fact lives.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VET_HINT_CAPTURE_SLUGS } from "@/components/pet-profile/VetPersonalChannelHint";

const CAPTURE_DIR = join(
  process.cwd(),
  "app",
  "(app)",
  "mis-mascotas",
  "[publicToken]",
  "eventos",
  "nuevo",
);

function pageSource(slug: string): string {
  return readFileSync(join(CAPTURE_DIR, slug, "page.tsx"), "utf8");
}

describe("VET_HINT_CAPTURE_SLUGS — every declared form renders the hint", () => {
  it("names at least the four obligation-bearing forms", () => {
    // Non-vacuity: an empty or gutted list would make every assertion below
    // pass over nothing, which is the one way this fence could go quietly
    // green while covering less.
    for (const required of ["vacuna", "antiparasitario", "esterilizacion", "microchip"]) {
      expect(VET_HINT_CAPTURE_SLUGS).toContain(required);
    }
    expect(VET_HINT_CAPTURE_SLUGS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(VET_HINT_CAPTURE_SLUGS)("%s renders <VetPersonalChannelHint>", (slug) => {
    const src = pageSource(slug);
    expect(src).toContain("VetPersonalChannelHint");
    // Both props, because the component's whole honesty rests on them: a page
    // that passed a hardcoded "owner" would make the hint claim a condition it
    // never checked.
    expect(src).toMatch(
      /<VetPersonalChannelHint\s+userId=\{user\.id\}\s+accessPath=\{accessPath\}/,
    );
    // AND the binding those identifiers resolve to. The assertion above proves
    // the two names APPEAR in that JSX, not that they mean anything — a page
    // that shadowed `accessPath` with a local constant would satisfy it. This
    // pins them to the guard's own return value, which is the fact the hint's
    // copy depends on.
    expect(src).toMatch(/const\s*\{[^}]*\buser\b[^}]*\baccessPath\b[^}]*\}\s*=\s*session;/);
    expect(src).toMatch(/\bsession\s*=\s*await\s+requireOwnedPetByToken\(/);
  });

  it("the forms deliberately left out do NOT carry it", () => {
    // The exclusions are a decision (see the component's header), so they are
    // pinned. If a future change wants the hint on a note or a weight, it has
    // to come here and say so.
    for (const slug of ["nota", "peso", "tatuaje"]) {
      expect(pageSource(slug)).not.toContain("VetPersonalChannelHint");
    }
  });
});

// The component's own decision. `db` is mocked because the only thing this
// asks of it is one profile row, and the two branches that matter are decided
// before and after that row.
const selectMock = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
  profiles: { id: "profiles.id", matriculaVerified: "profiles.matricula_verified" },
}));

function profileRow(row: Record<string, unknown> | undefined) {
  return {
    from: () => ({
      where: () => ({
        limit: async () => (row ? [row] : []),
      }),
    }),
  };
}

describe("VetPersonalChannelHint — when it speaks", () => {
  beforeEach(() => {
    selectMock.mockReset();
  });

  it("speaks to a matriculated vet acting as the holder", async () => {
    selectMock.mockReturnValue(profileRow({ matriculaVerified: true }));
    const { VetPersonalChannelHint } = await import(
      "@/components/pet-profile/VetPersonalChannelHint"
    );
    const out = await VetPersonalChannelHint({ userId: "u-1", accessPath: "owner" });
    expect(out).not.toBeNull();
  });

  it("says nothing to a holder with no validated matrícula", async () => {
    selectMock.mockReturnValue(profileRow({ matriculaVerified: false }));
    const { VetPersonalChannelHint } = await import(
      "@/components/pet-profile/VetPersonalChannelHint"
    );
    expect(await VetPersonalChannelHint({ userId: "u-1", accessPath: "owner" })).toBeNull();
  });

  it("says nothing when the profile row is missing", async () => {
    selectMock.mockReturnValue(profileRow(undefined));
    const { VetPersonalChannelHint } = await import(
      "@/components/pet-profile/VetPersonalChannelHint"
    );
    expect(await VetPersonalChannelHint({ userId: "u-1", accessPath: "owner" })).toBeNull();
  });

  // THE IMPORTANT NEGATIVE. On the org path the event IS professionally
  // signed, so this copy would be a lie — and it must not even ask the
  // database, because the answer could not change the verdict.
  it("says nothing on the org path, without querying", async () => {
    selectMock.mockReturnValue(profileRow({ matriculaVerified: true }));
    const { VetPersonalChannelHint } = await import(
      "@/components/pet-profile/VetPersonalChannelHint"
    );
    expect(await VetPersonalChannelHint({ userId: "u-1", accessPath: "org" })).toBeNull();
    expect(selectMock).not.toHaveBeenCalled();
  });
});
