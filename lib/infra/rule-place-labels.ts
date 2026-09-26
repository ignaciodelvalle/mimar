// The place a business rule is keyed on, as a label a person can tell apart
// (localidades-por-id D4).
//
// Since migration 0263 a rule may be keyed on a catalogue row (locality_id)
// or on a confirmed authority unit (authority_unit_id). Two homonyms share a
// name — "Mechita" — so the /reglas pages label each place with what tells it
// apart: the catalogue row's department, or the unit's name. A rule keyed to
// neither is labelled by its name, as before.

import { inArray } from "drizzle-orm";

import { arLocalities, authorityUnits, db } from "@/db";

export type RulePlaceKey = { kind: "locality" | "unit"; id: string };

type KeyedRule = {
  jurisdictionLocality: string | null;
  localityId: string | null;
  authorityUnitId: string | null;
};

export function rulePlaceQuery(key: RulePlaceKey): string {
  return key.kind === "unit" ? `unidad=${key.id}` : `lugar=${key.id}`;
}

function keyOf(r: KeyedRule): RulePlaceKey | null {
  if (r.authorityUnitId) return { kind: "unit", id: r.authorityUnitId };
  if (r.localityId) return { kind: "locality", id: r.localityId };
  return null;
}

export async function loadRulePlaceLabels(rules: ReadonlyArray<KeyedRule>) {
  const localityIds = [...new Set(rules.map((r) => r.localityId).filter((v): v is string => !!v))];
  const unitIds = [...new Set(rules.map((r) => r.authorityUnitId).filter((v): v is string => !!v))];
  const [localities, units] = await Promise.all([
    localityIds.length === 0
      ? []
      : db
          .select({
            id: arLocalities.id,
            name: arLocalities.localityName,
            department: arLocalities.departmentName,
          })
          .from(arLocalities)
          .where(inArray(arLocalities.id, localityIds)),
    unitIds.length === 0
      ? []
      : db
          .select({ id: authorityUnits.id, name: authorityUnits.name })
          .from(authorityUnits)
          .where(inArray(authorityUnits.id, unitIds)),
  ]);
  const byLocality = new Map(
    localities.map((l) => [l.id, l.department ? `${l.name} (${l.department})` : l.name]),
  );
  const byUnit = new Map(units.map((u) => [u.id, `${u.name} (unidad de autoridad)`]));

  const labelOf = (key: RulePlaceKey): string | null =>
    (key.kind === "unit" ? byUnit.get(key.id) : byLocality.get(key.id)) ?? null;

  const seen = new Map<string, { key: RulePlaceKey; label: string }>();
  for (const r of rules) {
    const key = keyOf(r);
    const id = key ? `${key.kind}:${key.id}` : "name";
    if (seen.has(id) || !key) continue;
    seen.set(id, { key, label: labelOf(key) ?? r.jurisdictionLocality ?? key.id });
  }
  // A name-keyed rule beside keyed ones is a place of its own too, but it has
  // no id to address; the chooser lists the keyed places.
  return { labelOf, distinctPlaces: [...seen.values()] };
}
