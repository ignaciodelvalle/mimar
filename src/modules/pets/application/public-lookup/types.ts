// Exported types for the public pet lookup use-case.

// NOTHING ABOUT THE OWNER TRAVELS THROUGH HERE. The consumer is the ANONYMOUS
// denuncia wizard, keyed on a token that hangs from the animal's collar — so
// anything this type carries is readable by anyone who can read the tag.
//
// It used to carry `ownerInitials` ("I.D."), on the reasoning that initials are
// not a full name. QA 2026-08-08 measured the result: step 4 answered "Esta
// mascota está registrada como CW-Luna (activa). Dueño: D.D." to an anonymous
// caller, while four other screens promise the owner that nothing of theirs is
// shown unless they turn it on. The module's own docblock promised a projection
// "without exposing the owner record" and then exposed a derivative of the
// owner's name.
//
// `petName` + `petStatus` fully satisfy the stated purpose — letting the
// reporter confirm the code matched a registered pet. The initials answered a
// question nobody needed answered, in the one flow (a mistreatment complaint)
// where the person asking is most likely to be in conflict with the owner.
//
// The AUTHENTICATED claim flow keeps its own initials
// (src/modules/pets/application/claim/) — there they help a would-be claimant
// confirm the match before opening a dispute, and the caller is identified.
export type PublicLookupResult =
  | { found: false }
  | {
      found: true;
      petName: string;
      petStatus: "active" | "lost" | "deceased";
    };
