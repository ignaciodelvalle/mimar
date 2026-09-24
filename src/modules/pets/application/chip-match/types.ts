// ConfirmChipMatchResult — result type for the chip-match confirmation use-case.

export type ConfirmChipMatchResult =
  | {
      ok: true;
      custodyEventId?: string;
      /**
       * Adjudication receipt for a `not_same` decision (RA-2 F6).
       *
       * The actor proved they know the disputed code (they typed it into the
       * alta) and said the animal is a different one. The receipt is the
       * HMAC-signed force token bound to that code, so the alta they are sent
       * back to can complete instead of running the same cross-check and
       * bouncing them to this very page again. Absent for `same`.
       *
       * It carries NO microchipId. Echoing the code back turned this response
       * into a chip oracle for every pet in the country; the client already
       * holds the value it typed and re-posts that. Nothing here discloses a
       * code the caller did not already supply.
       */
      chipConflict?: { forceToken: string };
    }
  | { error: string };
