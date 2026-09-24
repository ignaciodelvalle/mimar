// Public open-data datasets (Epic B, items 2-3) — Ley 27.275 active transparency.
//
// Five province-level AGGREGATE datasets, each computed from the SAME canonical
// fetcher the authenticated government dashboards use (so the public figures can
// never diverge from the internal ones), then routed through province-tier
// k=5 suppression (lib/open-data/province-suppression.ts) BEFORE anything leaves
// this module. A suppressed cell emits SUPPRESSED_MARKER in every numeric column
// — never a value, never a 0.
//
// WHAT IS PUBLISHED (the re-identification surface — see docs/datos-abiertos):
//  - Province NAME + ISO 3166-2:AR code (public geography).
//  - A population BASE count per rate dataset (an aggregate ≥ k; census-like).
//  - A coverage/compliance PERCENTAGE, or a raw count for the density dataset.
// WHAT IS NEVER PUBLISHED: no PII, no DNI, no per-pet rows, no public tokens, no
// locality/exact location, no raw numerator (recoverable only to a safe ≥ k
// approximation from base × rate for the cells we DO publish).
//
// UNAUTHENTICATED-SAFE: the builders run the fetchers with a synthesized
// admin/national ProjectionContext purely to obtain NATIONAL scope. The fetchers
// read analyticsDb (service-role, BYPASSRLS) and emit only aggregates, so this
// bypasses no meaningful guard — the ONLY output is k-anonymized province data.
// The heavy per-request cost is bounded by caching this at the route boundary.

import "server-only";

import { resolveAnalyticsPeriod } from "@/lib/analytics/analytics-period";
import {
  fetchMicrochipPenetrationByProvince,
  fetchPppComplianceByProvince,
} from "@/lib/analytics/compliance-metrics";
import { PROVINCE_ISO_MAP } from "@/lib/analytics/govt-dashboards";
import { fetchRabiesCoverageByProvince } from "@/lib/analytics/govt-home-kpis";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { buildProjectionContext } from "@/lib/metrics/context";
import { fetchSterilizationCoverage } from "@/lib/metrics/population-control";
import {
  type DensityRow,
  OPEN_DATA_K,
  type RateRow,
  SUPPRESSED_MARKER,
  type TaggedRow,
  suppressDensityProvinces,
  suppressRateProvinces,
} from "@/lib/open-data/province-suppression";
import { loadMortalityRawRollupByProvince } from "@/src/modules/panorama/infrastructure/repository";

/** The stable dataset slugs (the `[dataset]` route segment + download filenames). */
export const DATASET_IDS = [
  "cobertura-antirrabica",
  "cobertura-esterilizacion",
  "cobertura-microchip",
  "cumplimiento-ppp",
  "mortalidad",
] as const;

export type DatasetId = (typeof DATASET_IDS)[number];

export function isDatasetId(value: string): value is DatasetId {
  return (DATASET_IDS as readonly string[]).includes(value);
}

/** CC-BY 4.0 with the es-AR attribution string served alongside every dataset. */
export const OPEN_DATA_LICENSE = {
  id: "CC-BY-4.0",
  name: "Creative Commons Atribución 4.0 Internacional (CC BY 4.0)",
  url: "https://creativecommons.org/licenses/by/4.0/deed.es",
  // The attribution used to end "datos.mimar.gob.ar". A .gob.ar host is
  // delegated only to the State, and this one is not delegated at all — see
  // OWNED_WEB_DOMAINS in lib/infra/site-url.ts, where `mimar.gob.ar` is
  // deliberately absent "until it is delegated". Stamped into every dataset
  // download and every citation made from it, that string asserted a state
  // origin the project does not have. The name alone attributes correctly.
  attribution: "miMAR — Sistema de credencial digital de mascotas (Argentina).",
} as const;

/** A published column: machine name (the CSV/JSON key) + a citizen description. */
export type DatasetColumn = { name: string; description: string };

/** Static, citizen-facing metadata for one dataset. Rendered on the transparency
 *  page card AND embedded in every download's metadata (headers + JSON `meta`). */
export type DatasetDescriptor = {
  id: DatasetId;
  title: string;
  summary: string;
  /** What a single ROW represents (the k-anon unit). */
  unit: string;
  /** How often the underlying figures change. */
  cadence: string;
  columns: DatasetColumn[];
  /** One-line human summary of the suppression rule for this dataset. */
  suppressionRule: string;
};

// Shared column definitions (kept verbatim so page + dictionary + headers agree).
const COL_PROVINCIA: DatasetColumn = {
  name: "provincia",
  description: "Nombre de la provincia (o CABA).",
};
const COL_CODIGO_ISO: DatasetColumn = {
  name: "codigo_iso",
  description: "Código ISO 3166-2:AR de la jurisdicción (por ejemplo AR-B, AR-C).",
};

const RATE_SUPPRESSION = `Se publica "${SUPPRESSED_MARKER}" en las columnas numéricas cuando la población base es menor a ${OPEN_DATA_K}, o cuando el grupo cubierto o el grupo no cubierto tiene entre 1 y ${OPEN_DATA_K - 1} individuos. Supresión complementaria a nivel nacional para evitar la reconstrucción por diferencia.`;
const DENSITY_SUPPRESSION = `Se publica "${SUPPRESSED_MARKER}" cuando el conteo de la provincia es menor a ${OPEN_DATA_K}. Supresión complementaria a nivel nacional para evitar la reconstrucción por diferencia.`;

export const DATASET_DESCRIPTORS: Record<DatasetId, DatasetDescriptor> = {
  "cobertura-antirrabica": {
    id: "cobertura-antirrabica",
    title: "Cobertura de vacunación antirrábica",
    summary: "Porcentaje de perros con vacuna antirrábica vigente por provincia.",
    unit: "Una fila por provincia. El grupo protegido son los perros registrados de la provincia.",
    // La vigencia la decide rabiesCurrentlyValidCondition (lib/metrics/rabies.ts):
    // mira next_due_at primero y solo cae a la ventana móvil de 12 meses cuando
    // esa fecha falta. La metodología publicada decía "12 meses" a secas.
    cadence:
      "Actualización diaria. Vigencia según la fecha de próximo refuerzo de la dosis; sin esa fecha, se usa una ventana móvil de 12 meses.",
    columns: [
      COL_PROVINCIA,
      COL_CODIGO_ISO,
      {
        name: "perros_registrados",
        description:
          "Cantidad de perros registrados en la provincia (población base del indicador).",
      },
      {
        name: "cobertura_antirrabica_pct",
        description: "Porcentaje de esos perros con una vacuna antirrábica vigente (0-100).",
      },
    ],
    suppressionRule: RATE_SUPPRESSION,
  },
  "cobertura-esterilizacion": {
    id: "cobertura-esterilizacion",
    title: "Cobertura de esterilización",
    summary:
      "Porcentaje de mascotas activas con al menos una esterilización registrada, por provincia.",
    unit: "Una fila por provincia. El grupo protegido son las mascotas activas de la provincia.",
    cadence: "Actualización diaria (instantánea, acumulado histórico).",
    columns: [
      COL_PROVINCIA,
      COL_CODIGO_ISO,
      {
        name: "mascotas_activas",
        description: "Cantidad de mascotas activas en la provincia (población base del indicador).",
      },
      {
        name: "cobertura_esterilizacion_pct",
        description:
          "Porcentaje de esas mascotas con al menos una esterilización registrada (0-100).",
      },
    ],
    suppressionRule: RATE_SUPPRESSION,
  },
  "cobertura-microchip": {
    id: "cobertura-microchip",
    title: "Cobertura de microchip",
    summary: "Porcentaje de mascotas activas con microchip ISO activo, por provincia.",
    unit: "Una fila por provincia. El grupo protegido son las mascotas activas de la provincia.",
    cadence: "Actualización diaria (instantánea, acumulado histórico).",
    columns: [
      COL_PROVINCIA,
      COL_CODIGO_ISO,
      {
        name: "mascotas_activas",
        description: "Cantidad de mascotas activas en la provincia (población base del indicador).",
      },
      {
        name: "cobertura_microchip_pct",
        description: "Porcentaje de esas mascotas con un microchip ISO activo (0-100).",
      },
    ],
    suppressionRule: RATE_SUPPRESSION,
  },
  "cumplimiento-ppp": {
    id: "cumplimiento-ppp",
    title: "Cumplimiento de registro de perros potencialmente peligrosos (PPP)",
    summary:
      "Porcentaje de perros marcados como potencialmente peligrosos con la declaración de raza registrada, por provincia.",
    unit: "Una fila por provincia. El grupo protegido son los perros PPP de la provincia.",
    cadence: "Actualización diaria (instantánea, acumulado histórico).",
    columns: [
      COL_PROVINCIA,
      COL_CODIGO_ISO,
      {
        name: "perros_ppp",
        description:
          "Cantidad de perros marcados como potencialmente peligrosos en la provincia (población base del indicador).",
      },
      {
        name: "cumplimiento_ppp_pct",
        description: "Porcentaje de esos perros con la declaración de raza registrada (0-100).",
      },
    ],
    suppressionRule: RATE_SUPPRESSION,
  },
  mortalidad: {
    id: "mortalidad",
    title: "Fallecimientos registrados",
    summary: "Cantidad de mascotas registradas actualmente como fallecidas, por provincia.",
    unit: "Una fila por provincia. El grupo protegido son las mascotas fallecidas registradas de la provincia.",
    cadence: "Actualización diaria (instantánea, acumulado histórico).",
    columns: [
      COL_PROVINCIA,
      COL_CODIGO_ISO,
      {
        name: "fallecimientos_registrados",
        description:
          "Cantidad de mascotas de la provincia registradas actualmente como fallecidas.",
      },
    ],
    suppressionRule: DENSITY_SUPPRESSION,
  },
};

/** The public methodology + dictionary URLs embedded in every dataset's metadata. */
export function methodologyUrl(): string {
  return `${resolveSiteUrl()}/transparencia#metodologia`;
}
export function dictionaryUrl(): string {
  return `${resolveSiteUrl()}/transparencia#diccionario`;
}

/** The metadata block that travels with every download (headers + JSON `meta`). */
export type DatasetMeta = {
  id: DatasetId;
  title: string;
  summary: string;
  unit: string;
  cadence: string;
  license: typeof OPEN_DATA_LICENSE;
  methodologyUrl: string;
  dictionaryUrl: string;
  /** ISO timestamp of when this snapshot was generated (frozen by the route cache). */
  generatedAt: string;
  suppression: { k: number; marker: string; rule: string };
  columns: DatasetColumn[];
  rowCount: number;
  suppressedCount: number;
};

export type BuiltDataset = {
  meta: DatasetMeta;
  rows: Record<string, unknown>[];
};

/** A national-scope admin context — the ONLY thing this synthesizes; it grants
 *  NATIONAL aggregate scope, not any authenticated capability. */
function nationalContext() {
  return buildProjectionContext({ role: "admin" }, [], resolveAnalyticsPeriod({}));
}

/** Compact per-dataset builder config: how to fetch the raw rows and which
 *  published column carries the base + value. */
type RateBuild = {
  kind: "rate";
  baseColumn: string;
  pctColumn: string;
  /**
   * C8 (Y2/RA-3 audit) — the base column this one is a strict SUBSET of.
   *
   * Joint suppression used to group on the base column NAME (string equality),
   * which sees `perros_registrados` and `mascotas_activas` as unrelated files.
   * They are not: every registered dog is an active pet. An attacker downloads
   * both, joins on `codigo_iso`, and SUBTRACTS — and the difference (the
   * non-dogs of that province) is a population neither file ever k-checked.
   * Santa Cruz publishing 9 004 active pets and 9 000 registered dogs discloses
   * a group of 4 with both files fully "compliant".
   *
   * Declaring the containment lets the joint rule check the DIFFERENCE too.
   * Only the IMMEDIATE superset is declared; the walk below is transitive, so
   * `perros_ppp ⊂ perros_registrados ⊂ mascotas_activas` also compares ppp
   * against active pets — an attacker is not obliged to join adjacent files.
   */
  subsetOf?: string;
  fetch: () => Promise<RateRow[]>;
};
type DensityBuild = {
  kind: "density";
  countColumn: string;
  fetch: () => Promise<DensityRow[]>;
};

function isoOf(provinceName: string): string | null {
  return PROVINCE_ISO_MAP[provinceName] ?? null;
}

const BUILDERS: Record<DatasetId, RateBuild | DensityBuild> = {
  "cobertura-antirrabica": {
    kind: "rate",
    baseColumn: "perros_registrados",
    pctColumn: "cobertura_antirrabica_pct",
    // Every registered dog is an active pet (C8).
    subsetOf: "mascotas_activas",
    fetch: async () => {
      const rows = await fetchRabiesCoverageByProvince(nationalContext());
      return rows.flatMap((r) => {
        const code = isoOf(r.province);
        return code
          ? [
              {
                provinceCode: code,
                provinceName: r.province,
                numerator: r.vaccinated,
                denominator: r.total,
                ratePct: r.ratePct,
              },
            ]
          : [];
      });
    },
  },
  "cobertura-esterilizacion": {
    kind: "rate",
    baseColumn: "mascotas_activas",
    pctColumn: "cobertura_esterilizacion_pct",
    fetch: async () => {
      const { byProvince } = await fetchSterilizationCoverage(nationalContext());
      return byProvince.flatMap((r) => {
        const code = isoOf(r.province);
        if (!code) return [];
        // A row the AUTHENTICATED tier already withheld (D.10, lib/metrics/
        // province-disclosure.ts) carries no numbers to pass on. It is protected
        // in the public tier too, by construction: on a national/admin context
        // D.10 withholds only provinces whose base is sub-k, and
        // `isRateCellProtected` protects every one of those under its own first
        // clause (`denominator < k`).
        //
        // THAT SENTENCE USED TO SAY "exactly the provinces whose base is sub-k"
        // AND IT WAS FALSE (RA-1): D.10 also ran a national COMPLEMENTARY pass
        // that promoted an above-k province, whose base is by definition >= k —
        // so a 1.204-pet province arrived here with `denominator: 0`, and since
        // the public tier picks its own complement by NUMERATOR while D.10
        // picked by TOTAL, the identity of the suppressed province in this
        // dataset changed: one province vanished, another reappeared. The
        // complementary pass has since been removed from D.10 (it withholds the
        // row total instead), which is what makes the claim true again. Do not
        // reinstate an upstream complement without revisiting this feed.
        //
        // Feed a zero base so `suppressRateProvinces` reaches its verdict from
        // ITS OWN rule instead of trusting an upstream flag — and the row still
        // SHIPS, as
        // SUPPRESSED_MARKER in every numeric column: never dropped (absence is a
        // disclosure channel), never a 0 (a false zero asserts).
        if (r.suppressed) {
          return [
            {
              provinceCode: code,
              provinceName: r.province,
              numerator: 0,
              denominator: 0,
              ratePct: 0,
            },
          ];
        }
        return [
          {
            provinceCode: code,
            provinceName: r.province,
            numerator: r.sterilized,
            denominator: r.total,
            ratePct: r.ratePct,
          },
        ];
      });
    },
  },
  "cobertura-microchip": {
    kind: "rate",
    baseColumn: "mascotas_activas",
    pctColumn: "cobertura_microchip_pct",
    fetch: async () => {
      const rows = await fetchMicrochipPenetrationByProvince(nationalContext());
      return rows.flatMap((r) => {
        const code = isoOf(r.province);
        return code
          ? [
              {
                provinceCode: code,
                provinceName: r.province,
                numerator: r.chipped,
                denominator: r.active,
                ratePct: r.ratePct,
              },
            ]
          : [];
      });
    },
  },
  "cumplimiento-ppp": {
    kind: "rate",
    baseColumn: "perros_ppp",
    pctColumn: "cumplimiento_ppp_pct",
    // Every PPP dog is a registered dog (C8) — and, transitively, an active pet.
    subsetOf: "perros_registrados",
    fetch: async () => {
      const rows = await fetchPppComplianceByProvince(nationalContext());
      return rows.flatMap((r) => {
        const code = isoOf(r.province);
        return code
          ? [
              {
                provinceCode: code,
                provinceName: r.province,
                numerator: r.attested,
                denominator: r.flaggedCount,
                ratePct: r.ratePct,
              },
            ]
          : [];
      });
    },
  },
  mortalidad: {
    kind: "density",
    countColumn: "fallecimientos_registrados",
    // #40 alignment: reads the RAW rollup, not the map's already-suppressed
    // cells. The panorama now applies k=5 at province grain too, but its cells
    // arrive with sub-k counts NULLED — and this pipeline needs those counts to
    // run `suppressDensityProvinces`, whose complementary pass is strictly
    // stronger than the map's rule (see loadMortalityRawRollupByProvince). Same
    // k, same denominator criterion, raw input. A suppressed province is still
    // PUBLISHED as a row here, with SUPPRESSED_MARKER in place of the count —
    // the value is withheld, the province's existence is not.
    fetch: async () => {
      const rollup = await loadMortalityRawRollupByProvince({ role: "admin" }, []);
      return rollup.flatMap((r) => {
        const code = isoOf(r.province);
        return code ? [{ provinceCode: code, provinceName: r.province, count: r.count }] : [];
      });
    },
  },
};

/**
 * The declared containment lattice between BASE COLUMNS, derived once from the
 * builders' `subsetOf` so the relation lives next to the dataset that knows it.
 *
 * Column-level (not dataset-level) because two datasets publishing the SAME base
 * column must agree about what that column contains — the joint rule already
 * treats them as one population.
 */
const BASE_COLUMN_SUPERSET: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(BUILDERS)
      .filter((b): b is RateBuild => b.kind === "rate" && typeof b.subsetOf === "string")
      .map((b) => [b.baseColumn, b.subsetOf as string]),
  ),
);

/** Walk the declared containment upward, transitively. Cycle-safe by the `seen` set. */
function baseColumnAncestors(column: string): Set<string> {
  const seen = new Set<string>();
  let current = BASE_COLUMN_SUPERSET[column];
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    current = BASE_COLUMN_SUPERSET[current];
  }
  return seen;
}

type BaseColumnRelation = "same" | "subset" | "superset" | "unrelated";

/**
 * How `self`'s base column relates to `other`'s.
 *
 * `"superset"` means SELF contains OTHER (self − other is the leaky difference);
 * `"subset"` means the reverse. `"same"` is the pre-C8 shared-base group.
 */
function baseColumnRelation(self: string, other: string): BaseColumnRelation {
  if (self === other) return "same";
  if (baseColumnAncestors(other).has(self)) return "superset";
  if (baseColumnAncestors(self).has(other)) return "subset";
  return "unrelated";
}

/**
 * Province codes whose SHARED population base must be suppressed in this dataset.
 *
 * Several rate datasets publish the SAME base column computed from the SAME
 * denominator (today: `mascotas_activas` in cobertura-esterilizacion AND
 * cobertura-microchip). Per-dataset suppression alone lets an attacker join two
 * such files on codigo_iso and recover a base that one file withheld but the
 * other cleared — defeating the very marker the withholding file emitted. So the
 * base column follows a JOINT rule: a province suppressed in ANY dataset of the
 * shared-base group has its base marked in ALL of them. (The dataset-specific
 * numerator/rate columns keep their own per-dataset suppression.)
 *
 * C8 (Y2/RA-3 audit, 2026-08-05) — SHARING a base is not the only way two files
 * disclose each other. A base that CONTAINS another (`perros_registrados` ⊂
 * `mascotas_activas`) leaks by SUBTRACTION: both files pass their own k-checks
 * on their own populations, and the difference — the pets that are not dogs — is
 * a group nobody ever checked. The grouping therefore reads the declared
 * containment (`RateBuild.subsetOf`), not string equality of column names, and
 * suppresses the base on both sides when that difference is a protected small
 * positive. Symmetric by construction: each dataset recomputes the same
 * difference from its own side and reaches the same verdict.
 *
 * The group is DERIVED from the builders (rate datasets that share `baseColumn`,
 * plus those declaring a containment), so a future dataset publishing the same
 * or a nested base inherits the behavior with no code change here. The set is
 * computed from the underlying counts at build
 * time — never from another dataset's cached artifact — so each dataset's cached
 * unit is deterministic for its own build. Because each dataset caches
 * independently (daily TTL), two files built at different times can transiently
 * disagree on the joint set; that drift never exposes a sub-k value, since a base
 * is only published when no group member suppressed it at that build's snapshot
 * (i.e. it was already >= k). Coherence is per-build, not cross-file-absolute.
 *
 * `self`'s own suppression is folded in from `selfTagged` (already computed);
 * only OTHER members of the group are fetched. For a base published by a single
 * dataset this is a no-op that returns that dataset's own suppression set.
 */
async function sharedBaseSuppressedCodes(
  selfId: DatasetId,
  selfBuilder: RateBuild,
  selfTagged: readonly TaggedRow<RateRow>[],
): Promise<Set<string>> {
  const codes = new Set<string>();
  for (const { row, suppressed } of selfTagged) {
    if (suppressed) codes.add(row.provinceCode);
  }
  const selfDenominators = new Map<string, number>();
  for (const { row } of selfTagged) selfDenominators.set(row.provinceCode, row.denominator);

  for (const memberId of DATASET_IDS) {
    if (memberId === selfId) continue;
    const member = BUILDERS[memberId];
    if (member.kind !== "rate") continue;

    const relation = baseColumnRelation(selfBuilder.baseColumn, member.baseColumn);
    if (relation === "unrelated") continue;

    const tagged = suppressRateProvinces(await member.fetch());

    if (relation === "same") {
      for (const { row, suppressed } of tagged) {
        if (suppressed) codes.add(row.provinceCode);
      }
      continue;
    }
    for (const code of nestedBaseLeakCodes(selfDenominators, tagged, relation)) codes.add(code);
  }
  return codes;
}

/**
 * C8 — provinces whose base leaks through the DIFFERENCE between two NESTED
 * populations (e.g. active pets minus registered dogs).
 *
 * The two files are not interchangeable, so one file's own suppression says
 * nothing about the other's. What leaks is the difference — the members of the
 * superset that are not in the subset — which no per-dataset k-check ever looks
 * at.
 *
 * A difference of exactly 0 is safe and deliberately NOT suppressed: an empty
 * complement identifies nobody, the same reasoning `isRateCellProtected` applies
 * to a zero numerator. A NEGATIVE difference means the two fetchers disagree
 * about the same province (a subset larger than its superset); that is a data
 * fault, not a publishable aggregate, so it is suppressed rather than reasoned
 * about.
 */
function nestedBaseLeakCodes(
  selfDenominators: ReadonlyMap<string, number>,
  otherTagged: readonly TaggedRow<RateRow>[],
  relation: "subset" | "superset",
): string[] {
  const codes: string[] = [];
  for (const { row } of otherTagged) {
    const selfDenominator = selfDenominators.get(row.provinceCode);
    if (selfDenominator === undefined) continue;
    const difference =
      relation === "superset"
        ? selfDenominator - row.denominator
        : row.denominator - selfDenominator;
    if (difference !== 0 && difference < OPEN_DATA_K) codes.push(row.provinceCode);
  }
  return codes;
}

/**
 * Build one dataset: fetch canonical national rows, suppress at the province
 * tier, and shape the published rows (suppressed cells → SUPPRESSED_MARKER).
 * Rows are sorted by province name for a stable, diff-friendly download.
 *
 * NOTE: this reads the DB. It is meant to be called through a cache boundary
 * (the route wraps it in unstable_cache) so per-request DB load stays bounded.
 */
export async function buildDataset(id: DatasetId, now: Date = new Date()): Promise<BuiltDataset> {
  const descriptor = DATASET_DESCRIPTORS[id];
  const builder = BUILDERS[id];

  let rows: Record<string, unknown>[];
  let suppressedCount = 0;

  if (builder.kind === "rate") {
    const raw = await builder.fetch();
    const tagged = suppressRateProvinces(raw);
    // The base column obeys the JOINT shared-base rule; the pct column keeps its
    // own per-dataset suppression. baseSuppressedCodes is a superset of this
    // dataset's own suppressed provinces, so any pct-suppressed row is
    // base-suppressed too (a row never shows a base while hiding its own pct).
    const baseSuppressedCodes = await sharedBaseSuppressedCodes(id, builder, tagged);
    rows = tagged.map(({ row, suppressed }) => {
      const baseSuppressed = suppressed || baseSuppressedCodes.has(row.provinceCode);
      // suppressedCount = rows carrying at least one marker (== base-suppressed,
      // since base ⊇ pct suppression).
      if (baseSuppressed) suppressedCount += 1;
      return {
        provincia: row.provinceName,
        codigo_iso: row.provinceCode,
        [builder.baseColumn]: baseSuppressed ? SUPPRESSED_MARKER : row.denominator,
        [builder.pctColumn]: suppressed ? SUPPRESSED_MARKER : row.ratePct,
      };
    });
  } else {
    const raw = await builder.fetch();
    const tagged = suppressDensityProvinces(raw);
    rows = tagged.map(({ row, suppressed }) => {
      if (suppressed) suppressedCount += 1;
      return {
        provincia: row.provinceName,
        codigo_iso: row.provinceCode,
        [builder.countColumn]: suppressed ? SUPPRESSED_MARKER : row.count,
      };
    });
  }

  rows.sort((a, b) => String(a.provincia).localeCompare(String(b.provincia), "es"));

  const meta: DatasetMeta = {
    id,
    title: descriptor.title,
    summary: descriptor.summary,
    unit: descriptor.unit,
    cadence: descriptor.cadence,
    license: OPEN_DATA_LICENSE,
    methodologyUrl: methodologyUrl(),
    dictionaryUrl: dictionaryUrl(),
    generatedAt: now.toISOString(),
    suppression: { k: OPEN_DATA_K, marker: SUPPRESSED_MARKER, rule: descriptor.suppressionRule },
    columns: descriptor.columns,
    rowCount: rows.length,
    suppressedCount,
  };

  return { meta, rows };
}
