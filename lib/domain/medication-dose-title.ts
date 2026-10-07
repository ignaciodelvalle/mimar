// The title a medication course writes onto each of its dose reminders, and
// the way back from that title to the drug's own name.
//
// ONE PLACE FOR BOTH DIRECTIONS. `medication-start-use-case` writes
// "<drug> – Dosis" onto every scheduled dose, and that title is right where it
// stands alone (a reminder list, a notification). The libreta's PRÓXIMO
// section is not alone: both clients already say what KIND of row it is, so
// the stored title read "Dosis · Antiparasitario de amplio espectro – Dosis" on
// the phone. The reader strips the suffix with the inverse defined here, beside
// the writer, so the two cannot drift apart silently.
//
// The stored rows are not rewritten: reminders already in the database carry
// the suffixed title, and the inverse is what makes them read cleanly.

/** The suffix a dose reminder carries after the drug's name. */
export const MEDICATION_DOSE_TITLE_SUFFIX = " – Dosis";

/** The title stored on each scheduled dose reminder of a course. */
export function medicationDoseReminderTitle(drugName: string): string {
  return `${drugName}${MEDICATION_DOSE_TITLE_SUFFIX}`;
}

/**
 * The suffix as written, plus the dash variants a hand-typed or older title
 * may carry ("X - Dosis", "X — Dosis"). Anchored at the end: a drug whose own
 * name contains "Dosis" keeps it.
 */
const DOSE_SUFFIX_RE = /\s*[–—-]\s*Dosis\s*$/u;

/**
 * The drug's name, from a dose reminder's stored title.
 *
 * A title without the suffix is returned as-is (trimmed): a reminder written by
 * an older path still names SOMETHING, and that is better than an empty label.
 * A title that is ONLY the suffix keeps it, for the same reason.
 */
export function drugNameFromDoseReminderTitle(title: string): string {
  const trimmed = title.trim();
  const name = trimmed.replace(DOSE_SUFFIX_RE, "").trim();
  return name.length > 0 ? name : trimmed;
}
