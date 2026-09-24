// Does a `"YYYY-MM-DD"` string name a day that EXISTS?
//
// ONE RULE, TWO SCHEMAS, AND IT WAS ALMOST THREE. This lived as a private
// `isRealDay` inside `record-event.ts`, found in WU-K by a test. WU-P needed the
// identical check for a caretaker period's two dates and started to write a
// SECOND copy — on the server, in the endpoint, using a different mechanism (a
// round trip through `lib/utils/date-input-ar.ts`'s dd/mm/aaaa parser). Two
// implementations of one calendar in one repo is how they stop agreeing, and the
// server-side copy had the extra flaw of being invisible to the client, which
// would have paid a round trip to learn what it could have known locally.
//
// So the rule moves here, where both schemas import it and any third door gets it
// for free.
//
// A REGEX IS NOT ENOUGH, and finding that out cost a test. `"2026-02-31"` matches
// `/^\d{4}-\d{2}-\d{2}$/` perfectly, and `new Date("2026-02-31T12:00:00Z")` does
// not throw and is not `NaN` — JavaScript ROLLS IT OVER to 3 March. The server's
// own `parseDateInput` accepts it silently, and so does `parseArDateEndOfDay`
// (measured again in WU-P): a vaccination the owner dated 31 February lands in
// the ledger dated 3 March, and a caretaker period that was meant to end on the
// 28th ends three days later, with nothing anywhere reporting a substitution.
//
// The web never had this problem: `<input type="date">` cannot produce a day that
// does not exist. A JSON client can, which makes this exactly the kind of rule
// that has to be WRITTEN DOWN when a second door opens onto one spine.
//
// Round-tripping is the whole check: a rolled-over date stringifies back to a
// different day than it came from.

export function isRealArDay(value: string): boolean {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}
