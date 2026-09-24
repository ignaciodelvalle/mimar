// RETENTION-CLAIM GUARD — the subject-rights surface may never again assert a
// legal obligation to conserve sanitary events.
//
// THE DEFECT THIS PINS (2026-08-17)
// ---------------------------------
// `/cuenta/privacidad` told every user in the country that their pets' sanitary
// events are retained because "su conservación es obligatoria por norma (Res.
// SENASA, Ord. CABA 41.831, Ley 14.072)", and offered, as the only escape, to
// "evaluarlo caso por caso bajo la base legal de auditoría".
//
// No such obligation exists. Verified against docs/legal-framework-full.md:
//   * Ord. CABA 41.831 imposes registration/reporting duties on the OWNER
//     (art. 23 inscripción al 4° mes; art. 25 aviso de transferencia, baja o
//     muerte). It fixes no event-log retention period at all — and it is a
//     CABA ordinance, inapplicable to a user in Salta.
//   * Ley 14.072/1951 regulates the professional practice of veterinary
//     medicine (matriculación). Not a retention rule; national/CABA reach.
//   * No SENASA resolution in the repo's legal reference establishes one.
//
// WHY IT IS WORSE THAN A WRONG CITATION. Ley 25.326 art. 16 inc. 5 allows
// refusing supresión only "cuando existiera una obligación legal de conservar
// los datos". Invoking a non-existent obligation does not merely misinform —
// it DENIES the exercise of a right, and grounds a hábeas data.
//
// WHAT THE COPY MAY SAY INSTEAD: the true, verifiable reason (the health
// history belongs to the animal and outlives a single owner), that the
// retention period is still being defined, and that an erasure request over
// sanitary records will be assessed — with NO legal bar claimed.
//
// SCOPE — deliberately narrow, two files: the citizen-facing subject-rights
// page and its action card. This is not a repo-wide norm-citation ban; the
// same norms are cited legitimately elsewhere (rabies observation, microchip
// identification, owner obligations) where they really do say what we claim.
// Comments are stripped so a file documenting the old defect does not trip it.
//
// If this test fails, do not weaken the pattern. Remove the legal claim.
//
// Full errata: docs/architecture/retention-policy-pending-decision.md.

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

/** The citizen-facing surface that explains what survives an art. 16 erasure. */
const PRIVACY_PAGE = join("app", "(app)", "cuenta", "privacidad", "page.tsx");
const PRIVACY_ACTIONS = join("app", "(app)", "cuenta", "privacidad", "PrivacyActions.tsx");
const GUARDED_FILES = [PRIVACY_PAGE, PRIVACY_ACTIONS];

/**
 * Strip //-comments and block comments so a header documenting the defect is
 * not read as live copy. Mirrors confirm-label-grammar.guard.test.ts.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/[^"'`]*$/, ""))
    .join("\n");
}

/** JSX prose wraps at ~100 cols, so a banned phrase can straddle a newline. */
function renderedText(src: string): string {
  return stripComments(src).replace(/\s+/g, " ");
}

type BannedPhrase = { phrase: string; why: string };

// The retention-obligation assertion, in every spelling the removed copy used
// plus the obvious near-misses a rewrite would reach for.
const BANNED_PHRASES: BannedPhrase[] = [
  {
    phrase: "conservación es obligatoria",
    why: "the exact pre-fix assertion — no norm makes conservation of these records obligatory",
  },
  {
    phrase: "obligatoria por norma",
    why: "asserts a retention duty that does not exist",
  },
  {
    phrase: "se preservan por norma",
    why: "the PrivacyActions spelling of the same non-existent duty",
  },
  {
    phrase: "se conservan por norma",
    why: "same claim, different verb",
  },
  {
    phrase: "conservación obligatoria",
    why: "same claim, nominalized (the migration 0059 spelling)",
  },
  {
    phrase: "obligación legal de conservar",
    why: "the art. 16 inc. 5 formula — may only ever appear NEGATED, and this fence cannot tell the difference, so it is banned outright",
  },
  {
    phrase: "estamos obligados a conservar",
    why: "same claim in the first person",
  },
  {
    phrase: "por exigencia normativa",
    why: "same claim dressed as bureaucratic prose",
  },
  {
    phrase: "base legal de auditoría",
    why: "the discretionary escape hatch that made an unfounded refusal sound sourced",
  },
];

// A retention justification must not lean on these. They are cited honestly
// elsewhere in the repo (rabies observation, microchip, owner duties) — banned
// HERE only, on the surface that explains what survives an erasure request.
const BANNED_NORM_CITATIONS: BannedPhrase[] = [
  {
    phrase: "41.831",
    why: "a CABA ordinance imposing owner registration/reporting duties — it establishes no retention period, and does not reach a user outside CABA",
  },
  {
    phrase: "14.072",
    why: "regulates veterinary professional practice (matriculación), not data retention",
  },
  {
    phrase: "SENASA",
    why: "no SENASA resolution in docs/legal-framework-full.md establishes a retention period for these records",
  },
];

function readGuarded(relPath: string): string {
  return renderedText(readFileSync(join(ROOT, relPath), "utf8"));
}

describe("privacy retention claim — no invented legal obligation to conserve", () => {
  for (const relPath of GUARDED_FILES) {
    const posix = relPath.split(sep).join("/");

    describe(posix, () => {
      for (const { phrase, why } of BANNED_PHRASES) {
        it(`does not assert "${phrase}" — ${why}`, () => {
          expect(readGuarded(relPath)).not.toContain(phrase);
        });
      }

      for (const { phrase, why } of BANNED_NORM_CITATIONS) {
        it(`does not cite ${phrase} as retention grounds — ${why}`, () => {
          expect(readGuarded(relPath)).not.toContain(phrase);
        });
      }

      it("still cites Ley 25.326 — the RIGHT being exercised is not the thing under ban", () => {
        expect(readGuarded(relPath)).toContain("25.326");
      });
    });
  }

  // The ban alone is satisfiable by deleting the paragraph and telling the user
  // nothing. These pin that the honest replacement is actually present.
  describe("the honest replacement is present, not merely the absence of a lie", () => {
    const page = () => readGuarded(PRIVACY_PAGE);

    it("gives the real reason: the record belongs to the animal's health history", () => {
      expect(page()).toContain("historial de salud del animal");
    });

    it("discloses that the retention period is still being defined", () => {
      expect(page()).toMatch(/estamos definiendo por cuánto tiempo se conservan/);
    });

    it("states plainly that no legal obligation is invoked to refuse the erasure", () => {
      expect(page()).toMatch(/no invocamos ninguna obligación legal de conservación/);
    });

    it("offers the assessment as a request, not as a discretionary favour under audit law", () => {
      expect(page()).toMatch(/pedínoslo y lo revisamos/);
    });

    it("PrivacyActions points at the note instead of asserting a norm", () => {
      const actions = readGuarded(PRIVACY_ACTIONS);
      expect(actions).toContain("historial de salud del animal");
      expect(actions).toContain("ver nota debajo");
    });
  });
});
