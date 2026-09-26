// Locality aliases — the names people use that the INDEC catalogue does not.
//
// Banfield, Ramos Mejía, Ciudad Evita, Bernal: in Gran Buenos Aires INDEC models
// the conurbano as one component per PARTIDO, so the catalogue has "Lomas de
// Zamora" and not the towns inside it. The generated reference
// lib/reference/locality-aliases.json (scripts/generate-locality-aliases.ts)
// maps each such name to the census locality it belongs to, by the id INDEC
// itself publishes — never by name.
//
// SEARCH ONLY. An alias match is returned as THE TARGET CATALOGUE ROW (same id,
// same indecId, same localityName) plus `aliasName` for display. The stored
// locality is always that row, so routing, scope and events never see an
// alias, and nothing here is a name→locality resolution path: the place
// resolver (lib/place/) and jurisdiction-from-text never call it.
//
// The live catalogue has the last word on two things the generator could only
// check against the importer's CSV: a target that is no longer a live row, and
// an alias whose name IS a live row in that province (the manual "Olivos" row).
// Both drop the alias at query time, so a catalogue change can make an alias
// disappear but never point it somewhere else.

import { and, inArray, isNull } from "drizzle-orm";

import { type ArgentineLocality, arLocalities, db } from "@/db";
import { ISO_TO_INDEC_PROV } from "@/lib/infra/geo-join";
import { type ProvinceCode, provinceByCode } from "@/lib/reference/ar-provincias";
import aliasFile from "@/lib/reference/locality-aliases.json";
import { localitySlug } from "@/lib/reference/locality-slug";

/** Ranking of an alias hit, one notch under the catalogue's 1000/100/10: an
 * exact alias outranks every catalogue prefix, but never a catalogue exact. */
export const ALIAS_SCORE = { exact: 900, prefix: 90, contains: 9 } as const;

type AliasEntry = { name: string; slug: string; targetIndecId: string };

let index: AliasEntry[] | null = null;
function aliasIndex(): AliasEntry[] {
  if (index === null) {
    index = (aliasFile.aliases as Array<[string, string]>).map(([name, targetIndecId]) => ({
      name,
      slug: localitySlug(name),
      targetIndecId,
    }));
  }
  return index;
}

export type AliasHit = { name: string; slug: string; targetIndecId: string; score: number };

/**
 * Pure: the alias entries a query matches, best first, optionally inside one
 * province (the first two digits of an INDEC id are its province).
 */
export function matchAliases(query: string, provinceCode?: ProvinceCode): AliasHit[] {
  const q = localitySlug(query);
  if (q.length < 2) return [];
  const indecProvince = provinceCode ? ISO_TO_INDEC_PROV[provinceCode] : undefined;
  if (provinceCode && !indecProvince) return [];
  const hits: AliasHit[] = [];
  for (const a of aliasIndex()) {
    if (indecProvince && !a.targetIndecId.startsWith(indecProvince)) continue;
    const score =
      a.slug === q
        ? ALIAS_SCORE.exact
        : a.slug.startsWith(q)
          ? ALIAS_SCORE.prefix
          : a.slug.includes(q)
            ? ALIAS_SCORE.contains
            : 0;
    if (score > 0) hits.push({ ...a, score });
  }
  return hits.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name, "es"));
}

/** One alias hit resolved to its live target row. */
export type AliasSearchRow = {
  row: ArgentineLocality;
  aliasName: string;
  score: number;
};

/**
 * The alias hits for a query, each resolved to its LIVE target row. At most
 * `limit` — the caller merges them with the catalogue's own matches.
 */
export async function searchLocalityAliases(input: {
  query: string;
  provinceCode?: ProvinceCode;
  limit: number;
}): Promise<AliasSearchRow[]> {
  const hits = matchAliases(input.query, input.provinceCode).slice(0, input.limit);
  if (hits.length === 0) return [];

  const [targets, shadowing] = await Promise.all([
    db
      .select()
      .from(arLocalities)
      .where(
        and(
          inArray(arLocalities.indecId, [...new Set(hits.map((h) => h.targetIndecId))]),
          isNull(arLocalities.removedAt),
        ),
      ),
    // A live row with the alias's own name already answers the search.
    db
      .select({ provinceCode: arLocalities.provinceCode, slug: arLocalities.localitySlug })
      .from(arLocalities)
      .where(
        and(
          inArray(arLocalities.localitySlug, [...new Set(hits.map((h) => h.slug))]),
          isNull(arLocalities.removedAt),
        ),
      ),
  ]);

  const byIndecId = new Map(targets.map((t) => [t.indecId, t]));
  const shadowed = new Set(shadowing.map((s) => `${s.provinceCode}|${s.slug}`));
  const out: AliasSearchRow[] = [];
  for (const h of hits) {
    const row = byIndecId.get(h.targetIndecId);
    if (!row || !provinceByCode(row.provinceCode)) continue;
    if (shadowed.has(`${row.provinceCode}|${h.slug}`)) continue;
    out.push({ row, aliasName: h.name, score: h.score });
  }
  return out;
}
