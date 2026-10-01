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

function parseDay(value: string): { year: number; month: number; day: number } | null {
  const match = DAY_PATTERN.exec(value);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}
