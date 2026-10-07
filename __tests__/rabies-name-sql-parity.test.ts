// Integration test — the SQL rabies matcher (rabiesVaccineNameSql) answers
// exactly what the TypeScript one (isRabiesVaccineName) answers, name by name
// (surface audit 2026-10-07, item A).
//
// The owner's credential decides "is this a rabies dose" in TypeScript; the
// govt coverage KPIs, panorama, trends and outreach decide it in SQL. Until
// 2026-10-07 the two used different patterns, so "Rabia" or a decomposed "á"
// was a rabies dose on the pet's document and not in the coverage figure.
// This runs each name through the real Postgres `unaccent` — a mock could not
// say whether it folds a decomposed accent the way NFD does.
//
// Requires the local Supabase Postgres (127.0.0.1:54322).

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";
import { rabiesVaccineNameSql } from "@/lib/metrics/rabies";
import { isRabiesVaccineName } from "@/lib/reference/lookups";

const NAMES = [
  "Antirrábica",
  "antirrábica",
  "Antirrabica",
  "ANTIRRABICA",
  "ANTIRRÁBICA",
  "Antirrábica",
  "  antirrábica  ",
  "Rabia",
  "RABIES",
  "Vacuna antirrábica",
  "DHPP + antirrábica",
  "antirrábica refuerzo post-exposición",
  "Séxtuple (DHPPi-L)",
  "Quíntuple (DHPPi)",
  "Triple felina (FVRCP)",
  "moquillo + parvovirus",
  "Leptospira",
  "",
];

describe("rabiesVaccineNameSql ≡ isRabiesVaccineName", () => {
  it.each(NAMES)("%j gets the same verdict in SQL and in TypeScript", async (name) => {
    const rows = (await db.execute(
      sql`SELECT ${rabiesVaccineNameSql(sql`${name}::text`)} AS is_rabies`,
    )) as unknown as Array<{ is_rabies: boolean }>;
    expect(rows[0]?.is_rabies).toBe(isRabiesVaccineName(name));
  });

  it("the list exercises both verdicts (the parity is not vacuous)", () => {
    const verdicts = new Set(NAMES.map((n) => isRabiesVaccineName(n)));
    expect(verdicts).toEqual(new Set([true, false]));
  });
});
