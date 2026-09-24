// `activeOwnerHeadline` — the variant-B sentence, and the one field it splits on.
//
// WHAT THIS HAS TO PROVE
// ---------------------------------------------------------------------------
// That a MISSING set of owner initials is not rendered as "there is a registered
// owner whose initials we happen to be omitting". A refugio holding an animal
// under `shelter_custody` has no owner row and therefore no initials, and the
// lookup still answers `variant: "active_owner"` — so the pre-fix sentence
// asserted a registered dueño/a for an animal that has none, to the person who is
// about to dispute exactly that.
//
// TESTED AS A FUNCTION, NOT THROUGH A RENDER. `ResultStep` is one arm of a
// three-step state machine driven by two server actions; reaching this sentence
// through the wizard's public surface means mocking both actions and driving a
// form to get at a `toBe`. The sentence was extracted for that reason, which is
// the doctrine the mobile view-models already follow.

import { describe, expect, it } from "vitest";

import { activeOwnerHeadline } from "./ClaimWizard";

describe("the active-custody headline", () => {
  it("names a registered owner when there ARE initials", () => {
    expect(activeOwnerHeadline("Pampa", "M. G.")).toBe(
      "Pampa ya tiene dueño/a registrado/a (M. G.).",
    );
  });

  it("says CUSTODY, not owner, when there are no initials", () => {
    // THE BUG. `null` initials is the shelter-custody case, and the old copy read
    // "Pampa ya tiene dueño/a registrado/a." — a claim about a person who does
    // not exist in the record.
    expect(activeOwnerHeadline("Pampa", null)).toBe(
      "Pampa ya está bajo la custodia de otra persona u organización.",
    );
  });

  it("does not leave a dangling parenthesis or a doubled full stop", () => {
    // The pre-fix shape built the sentence out of three JSX fragments, which is
    // how a conditional segment leaves punctuation behind. Asserted separately
    // from the wording so a future rewording cannot quietly reintroduce it.
    const withInitials = activeOwnerHeadline("Rocco", "A. B.");
    const without = activeOwnerHeadline("Rocco", null);
    for (const sentence of [withInitials, without]) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence).not.toContain("..");
      expect(sentence).not.toContain("()");
    }
    expect(without).not.toContain("(");
  });

  it("treats an EMPTY initials string as no initials", () => {
    // `ownerInitials` is `string | null` on the wire, but the derivation upstream
    // builds it from name parts — an owner row with an unparseable display name
    // can hand back "". Rendering "(" + "" + ")" is the same defect as the null
    // case with an extra pair of brackets.
    expect(activeOwnerHeadline("Pampa", "")).toBe(
      "Pampa ya está bajo la custodia de otra persona u organización.",
    );
  });
});
