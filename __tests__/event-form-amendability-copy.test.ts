// A form may only tell the owner an entry is unfixable when it actually is.
//
// WHY THIS EXISTS — I WROTE THE SECOND FALSE CLAIM WHILE FIXING THE FIRST
// ---------------------------------------------------------------------------
// On 2026-08-17 the vaccination form's callout promised that naming the vet
// could make the entry "official". It could not: the server stamps owner
// authorship on everything written there. Replacing that promise, the first
// draft said the record "no se puede editar ni borrar después" — and
// `vaccination_administered` IS in AMENDABLE_EVENT_TYPES, with a working
// "Corregir registro" button on the event page. One false statement had been
// swapped for another, in the very commit that existed to remove it. A reviewer
// caught it before the push.
//
// The lesson is not "be careful with copy". It is that a claim about
// reversibility has a SOURCE OF TRUTH in this codebase — the allowlist — and
// nothing tied the words to it. So this fence derives the expectation FROM the
// allowlist rather than restating it: if a type is ever added to or removed
// from AMENDABLE_EVENT_TYPES, the form that writes it has to agree or this
// fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AMENDABLE_EVENT_TYPES } from "@/lib/infra/amendment";

const ROOT = join(__dirname, "..");
const FORMS_DIR = join(ROOT, "app", "(app)", "mis-mascotas", "[publicToken]", "eventos", "nuevo");

/**
 * The owner-facing forms whose copy makes a reversibility claim, mapped to the
 * event type each one writes. Hand-maintained because the mapping lives in a
 * server action, not in the component — but every entry is asserted against the
 * allowlist below, so a wrong mapping cannot pass silently.
 */
const FORMS: ReadonlyArray<{ file: string; eventType: string }> = [
  { file: "vacuna/VaccinationForm.tsx", eventType: "vaccination_administered" },
  { file: "fallecimiento/DeathRecordForm.tsx", eventType: "death_recorded" },
];

/**
 * Phrases that tell the owner the entry can never be changed. Matching is on
 * the RENDERED copy only — comments are stripped first, because both files
 * discuss the wrong wording at length in their own notes and a fence that read
 * those would flag the explanation instead of the claim.
 */
const CLAIMS_UNFIXABLE = [
  /no se puede editar/i,
  /no se puede corregir/i,
  /no se puede deshacer/i,
  /no se puede modificar/i,
];

/** Strips block and line comments so only rendered strings remain. */
function renderedCopy(file: string): string {
  const src = readFileSync(join(FORMS_DIR, file), "utf8");
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("a form claims irreversibility only for events that really are", () => {
  it("maps every form to a real event type", () => {
    // NON-VACUITY, and a guard on the hand-maintained mapping: a typo here
    // would otherwise make each assertion below test nothing.
    expect(FORMS.length).toBeGreaterThan(0);
    for (const { file } of FORMS) {
      expect(renderedCopy(file).length).toBeGreaterThan(200);
    }
  });

  it("says nothing is fixable only when the allowlist agrees", () => {
    const wrong: string[] = [];
    for (const { file, eventType } of FORMS) {
      const amendable = (AMENDABLE_EVENT_TYPES as readonly string[]).includes(eventType);
      const claimsUnfixable = CLAIMS_UNFIXABLE.some((re) => re.test(renderedCopy(file)));
      if (amendable && claimsUnfixable) {
        wrong.push(`${file}: dice que no se puede corregir, pero ${eventType} SÍ es enmendable`);
      }
      if (!amendable && !claimsUnfixable) {
        wrong.push(`${file}: ${eventType} NO es enmendable y el formulario no lo advierte`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the two halves of the expectation genuinely different", () => {
    // Positive control in BOTH directions: the test above would pass trivially
    // if both forms happened to fall on the same side. They must not.
    const amendability = FORMS.map((f) =>
      (AMENDABLE_EVENT_TYPES as readonly string[]).includes(f.eventType),
    );
    expect(new Set(amendability).size).toBe(2);
  });
});
