// An animal's age and its birth date, in both directions.
//
// Owners rarely know a birth date; they know "unos dos años". The registry
// stores a DATE, flagged `birth_date_is_estimated` when it came from an age, and
// every form shows that date back as an age. Both directions live here so the
// web, the app and the server convert the same way.
//
// THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT IS DELIBERATE
// ---------------------------------------------------------------------------
//   · age → date (`estimatedBirthDateFromAge`) is the arithmetic the web wizard
//     and the v1 alta always used, moved here byte for byte (owner-pet-actions,
//     2026-10-01). It reads the clock of the machine it runs on; changing it
//     would change dates already being written, which a move must not do.
//   · date → age (`petAgeFromBirthDate`) counts whole months on ARGENTINA's
//     calendar, whatever zone the code runs in. The web's own version read
//     `Date` getters in the runtime's zone, so a browser in Buenos Aires and a
//     server in UTC could answer a month apart for the same animal on the same
//     day — harmless on a form, fatal for a check that compares the age a form
//     showed with the age the server computes. One answer everywhere is the
//     whole point of this direction.
//
// At any instant away from the three hours where Argentina's day and UTC's
// differ, an estimate reads back as the age it was made from.

/** An age as a form holds it: blank fields are `null`. */
export type PetAge = { years: number | null; months: number | null };

/** Argentina has kept UTC−3 all year since 2009; no zone database needed. */
const AR_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The estimated birth date for an age stated `now`, as `YYYY-MM-DD`, or `null`
 * when no age was stated. A stated zero is an age (today), not a blank.
 */
export function estimatedBirthDateFromAge(age: PetAge, now: Date): string | null {
  if (age.years === null && age.months === null) return null;
  const totalMonths = (age.years ?? 0) * 12 + (age.months ?? 0);
  const dob = new Date(now.getTime());
  dob.setMonth(dob.getMonth() - totalMonths);
  return dob.toISOString().slice(0, 10);
}

/**
 * How old an animal born on `dateOfBirth` is `now`, in whole years and months,
 * counted on Argentina's calendar. A month counts once its day has come; a date
 * not reached yet reads as zero. No date — or one that is not a date — reads as
 * no age, never as zero.
 */
export function petAgeFromBirthDate(dateOfBirth: string | null, now: Date): PetAge {
  const born = dateOfBirth === null ? null : parseDay(dateOfBirth);
  if (born === null) return { years: null, months: null };
  const today = parseDay(new Date(now.getTime() - AR_UTC_OFFSET_MS).toISOString().slice(0, 10));
  if (today === null) return { years: null, months: null };
  let totalMonths = (today.year - born.year) * 12 + (today.month - born.month);
  if (today.day < born.day) totalMonths -= 1;
  if (totalMonths < 0) totalMonths = 0;
  return { years: Math.floor(totalMonths / 12), months: totalMonths % 12 };
}

/** One day, for the tolerance window below. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `age` is the age an animal born on `dateOfBirth` reads as `now` —
 * give or take a day, because the form computed the age it showed at one
 * instant and the server compares at another, and the two can straddle a
 * midnight. This is how an EDIT tells an age the person posted back untouched
 * from one they typed: `resolveEditedBirthDate` keeps the stored date on a
 * match, and `editedAgeRefusal` lets a stored (possibly odd) age through.
 * Moved here from `resolveEditedBirthDate` so the two read one definition.
 */
export function ageMatchesBirthDate(dateOfBirth: string, age: PetAge, now: Date): boolean {
  const asked = (age.years ?? 0) * 12 + (age.months ?? 0);
  for (const offset of [-DAY_MS, 0, DAY_MS]) {
    const shown = petAgeFromBirthDate(dateOfBirth, new Date(now.getTime() + offset));
    if (shown.years !== null && shown.years * 12 + (shown.months ?? 0) === asked) return true;
  }
  return false;
}

function parseDay(value: string): { year: number; month: number; day: number } | null {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// How old an animal can PLAUSIBLY be — the rule both clients and the server
// apply to a stated age and to a birth date (alta-validacion-edad, 2026-10-07).
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS NEXT TO `MAX_PET_AGE_YEARS` (250, `input/pet-profile-fields.ts`)
// That ceiling keeps the age → date DERIVATION well-formed and CLAMPS: it was
// never a data-quality rule, and it let "3310 años" travel all the way to the
// app's confirm step, where it read back as typed and was then silently stored
// as 250 (QA on a real phone). This is the data-quality rule, and it REFUSES:
// a number nobody's dog has ever been is a typo, and the owner is the only
// person who can say what they meant.
//
// ONE GENERIC CAP, NOT A TABLE OF LIFESPANS. The codebase models no
// species-specific lifespan anywhere, and a per-species table (a ferret at 12, a
// cobayo at 8…) is a veterinary claim nobody here has made. 40 years clears
// every dog and cat on record (the oldest documented cat was 38) and, a
// fortiori, every conejo, cobayo and hurón.
//
// THE ONE EXCEPTION IS `other`, AND IT IS THE EXCEPTION THE CODEBASE ALREADY
// DOCUMENTS: `MAX_PET_AGE_YEARS` says why — in Argentina "otro" is routinely a
// tortuga terrestre, 50-100 years is ordinary for one, and they are handed down
// within families. Capping it at 40 would refuse a legitimate registration, so
// `other` keeps the existing derivation ceiling as its plausibility cap.

/** The plausibility cap on a stated age for every species except `other`. */
export const MAX_STATED_AGE_YEARS = 40;

/**
 * The cap for `other` — the derivation ceiling `MAX_PET_AGE_YEARS` in
 * `input/pet-profile-fields.ts`, restated rather than imported because that
 * module is a zod schema leaf and this one is import-free reference data. The
 * contract test pins the two to the same number.
 */
export const MAX_STATED_AGE_YEARS_OTHER = 250;

/**
 * How many whole years an animal of `species` may be stated to be. An unknown
 * or absent species gets the generic cap — the strict side, since nothing about
 * the animal says it might be a tortoise.
 */
export function maxStatedAgeYears(species: string | null | undefined): number {
  return species === "other" ? MAX_STATED_AGE_YEARS_OTHER : MAX_STATED_AGE_YEARS;
}

export type BirthDateRefusal = "BIRTH_DATE_INVALID" | "BIRTH_DATE_IN_FUTURE" | "BIRTH_DATE_TOO_OLD";

/**
 * Whether `dateOfBirth` (`YYYY-MM-DD`) is a date an animal of `species` could
 * have been born on, as of `now`. `null` when it is.
 *
 *   · not a real calendar day → BIRTH_DATE_INVALID (`2026-02-30` is not a day);
 *   · after today → BIRTH_DATE_IN_FUTURE. "Today" is the LATER of Argentina's
 *     day and UTC's, deliberately: `estimatedBirthDateFromAge` writes UTC's day,
 *     so between 21:00 and midnight in Buenos Aires an age of "0" derives
 *     tomorrow's Argentine date, and that is not a typo anybody made;
 *   · older than `maxStatedAgeYears(species)` on Argentina's calendar, the same
 *     count `petAgeFromBirthDate` makes → BIRTH_DATE_TOO_OLD.
 */
export function birthDateRefusal(
  dateOfBirth: string,
  species: string | null | undefined,
  now: Date,
): BirthDateRefusal | null {
  const born = parseDay(dateOfBirth);
  if (born === null || !isRealDay(born)) return "BIRTH_DATE_INVALID";
  const latestToday = now.toISOString().slice(0, 10);
  if (dateOfBirth > latestToday) return "BIRTH_DATE_IN_FUTURE";
  const age = petAgeFromBirthDate(dateOfBirth, now);
  const months = (age.years ?? 0) * 12 + (age.months ?? 0);
  return months > maxStatedAgeYears(species) * 12 ? "BIRTH_DATE_TOO_OLD" : null;
}

function isRealDay(day: { year: number; month: number; day: number }): boolean {
  // `setUTCFullYear`, not `Date.UTC(year, …)`: the latter maps years 0-99 to
  // 1900-1999, so "0050-01-01" would read as not-a-day instead of too old.
  const probe = new Date(0);
  probe.setUTCFullYear(day.year, day.month - 1, day.day);
  return (
    probe.getUTCFullYear() === day.year &&
    probe.getUTCMonth() === day.month - 1 &&
    probe.getUTCDate() === day.day
  );
}
