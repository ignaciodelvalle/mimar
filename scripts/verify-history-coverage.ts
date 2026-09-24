/**
 * scripts/verify-history-coverage.ts
 *
 * Asserts the full "no panel without data" history coverage matrix:
 *
 *   FEATURED (Córdoba, Salta) × {2024, 2025, 2026} × 12 dimensions → all COUNT > 0
 *   SPOT-CHECK (Buenos Aires, Mendoza, Tucumán) × {2024, 2025, 2026} × 8 pet_events dims
 *
 * Uses the SAME key/column each real consumer uses:
 *   - Via pets JOIN:       pet_registered, vaccination_administered (rabies),
 *                          sterilization_performed, death_recorded, adoption_finalized
 *   - Via payload->>'province': outbreak_signal (loadZoonosisByUnit),
 *                                incident_reported bite (loadMordedurassByUnit),
 *                                payload->>'kind'='pet_lost' (loadPerdidasByUnit)
 *   - Via column:          welfare_reports.jurisdiction_province (loadDenunciasByUnit),
 *                          cases.jurisdiction_province (custody_dispute / custody_episode),
 *                          appointments × service_offerings.jurisdiction_province (fetchCampaignDashboard)
 *
 * Exit 0 — all required cells non-zero.
 * Exit 1 — one or more Córdoba/Salta cells are zero (BLOCKED).
 */

// ---------------------------------------------------------------------------
// 1. Env bootstrap (must run before ../db is imported)
// ---------------------------------------------------------------------------

import { config as loadEnv } from "dotenv";
import type { SQL } from "drizzle-orm";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ---------------------------------------------------------------------------
// 2. Safety guard — local DB only (mirrors seed-panorama.ts pattern)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? "";

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in .env.local — aborting.");
  process.exit(2);
}

const ALLOW_REMOTE = process.argv.includes("--allow-remote");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal", "::1"]);

function parsePgHost(url: string): string | null {
  const m = url.match(/^postgres(?:ql)?:\/\/[^@]+@([^:/]+)/);
  return m ? m[1] : null;
}

const dbHost = parsePgHost(DATABASE_URL);
if (!ALLOW_REMOTE && dbHost && !LOCAL_HOSTS.has(dbHost)) {
  console.error(
    `ABORT: verify-history-coverage target is NOT a local Postgres (host: ${dbHost}).`,
    "Pass --allow-remote to override.",
  );
  process.exit(4);
}

// ---------------------------------------------------------------------------
// 3. Deferred imports (after env is populated)
// ---------------------------------------------------------------------------

const { sql } = await import("drizzle-orm");
const { db } = await import("../db");

// ---------------------------------------------------------------------------
// 4. Constants
// ---------------------------------------------------------------------------

const FEATURED_PROVINCES = ["Córdoba", "Salta"] as const;
const SPOT_PROVINCES = ["Buenos Aires", "Mendoza", "Tucumán"] as const;
const ALL_PROVINCES = [...FEATURED_PROVINCES, ...SPOT_PROVINCES] as const;
const YEARS = [2024, 2025, 2026] as const;

type Year = (typeof YEARS)[number];

// ---------------------------------------------------------------------------
// 5. Query helpers
// ---------------------------------------------------------------------------

type CellRow = { province: string; year: number; n: number };
type Matrix = Record<string, Record<number, number>>;

function buildMatrix(rows: CellRow[]): Matrix {
  const m: Matrix = {};
  for (const r of rows) {
    m[r.province] ??= {};
    m[r.province][r.year] = r.n;
  }
  return m;
}

function getCount(m: Matrix, province: string, year: Year): number {
  return m[province]?.[year] ?? 0;
}

function normalizeRows(rows: unknown[]): CellRow[] {
  return (rows as Array<Record<string, unknown>>)
    .filter((r) => r.province != null)
    .map((r) => ({
      province: String(r.province),
      year: Number(r.year),
      n: Number(r.n),
    }));
}

// SQL value lists — values are hardcoded constants, safe for interpolation
const allProvsSql = sql.join(
  ALL_PROVINCES.map((p) => sql`${p}`),
  sql`, `,
);
const yearsSql = sql.join(
  YEARS.map((y) => sql`${y}`),
  sql`, `,
);
const featuredProvsSql = sql.join(
  FEATURED_PROVINCES.map((p) => sql`${p}`),
  sql`, `,
);

// pet_events via pets JOIN (province from pets.jurisdiction_province)
async function queryPetEventsJoin(
  eventType: string,
  extraWhere: SQL | null = null,
): Promise<CellRow[]> {
  const base = sql`
    SELECT p.jurisdiction_province AS province,
           EXTRACT(YEAR FROM pe.occurred_at)::int AS year,
           COUNT(*) AS n
    FROM pet_events pe
    JOIN pets p ON p.id = pe.pet_id
    WHERE p.jurisdiction_province IN (${allProvsSql})
      AND pe.event_type = ${eventType}
      AND EXTRACT(YEAR FROM pe.occurred_at) IN (${yearsSql})
  `;
  const withExtra = extraWhere
    ? sql`${base} AND ${extraWhere} GROUP BY p.jurisdiction_province, EXTRACT(YEAR FROM pe.occurred_at)::int ORDER BY 1, 2`
    : sql`${base} GROUP BY p.jurisdiction_province, EXTRACT(YEAR FROM pe.occurred_at)::int ORDER BY 1, 2`;
  const rows = await db.execute(withExtra);
  return normalizeRows(Array.from(rows));
}

// pet_events via payload->>'province'
async function queryPetEventsPayload(extraWhere: SQL): Promise<CellRow[]> {
  const rows = await db.execute(sql`
    SELECT (pe.payload->>'province') AS province,
           EXTRACT(YEAR FROM pe.occurred_at)::int AS year,
           COUNT(*) AS n
    FROM pet_events pe
    WHERE (pe.payload->>'province') IN (${allProvsSql})
      AND EXTRACT(YEAR FROM pe.occurred_at) IN (${yearsSql})
      AND ${extraWhere}
    GROUP BY (pe.payload->>'province'), EXTRACT(YEAR FROM pe.occurred_at)::int
    ORDER BY 1, 2
  `);
  return normalizeRows(Array.from(rows));
}

// welfare_reports by jurisdiction_province
async function queryWelfareReports(): Promise<CellRow[]> {
  const rows = await db.execute(sql`
    SELECT jurisdiction_province AS province,
           EXTRACT(YEAR FROM created_at)::int AS year,
           COUNT(*) AS n
    FROM welfare_reports
    WHERE jurisdiction_province IN (${allProvsSql})
      AND EXTRACT(YEAR FROM created_at) IN (${yearsSql})
    GROUP BY jurisdiction_province, EXTRACT(YEAR FROM created_at)::int
    ORDER BY 1, 2
  `);
  return normalizeRows(Array.from(rows));
}

// cases by case_kind and jurisdiction_province
async function queryCases(caseKind: string): Promise<CellRow[]> {
  const rows = await db.execute(sql`
    SELECT jurisdiction_province AS province,
           EXTRACT(YEAR FROM opened_at)::int AS year,
           COUNT(*) AS n
    FROM cases
    WHERE case_kind = ${caseKind}
      AND jurisdiction_province IN (${allProvsSql})
      AND EXTRACT(YEAR FROM opened_at) IN (${yearsSql})
    GROUP BY jurisdiction_province, EXTRACT(YEAR FROM opened_at)::int
    ORDER BY 1, 2
  `);
  return normalizeRows(Array.from(rows));
}

// campaigns: appointments × service_offerings (featured provinces only)
async function queryCampaigns(): Promise<CellRow[]> {
  const rows = await db.execute(sql`
    SELECT so.jurisdiction_province AS province,
           EXTRACT(YEAR FROM a.created_at)::int AS year,
           COUNT(*) AS n
    FROM appointments a
    JOIN service_offerings so ON so.id = a.service_offering_id
    WHERE so.jurisdiction_province IN (${featuredProvsSql})
      AND EXTRACT(YEAR FROM a.created_at) IN (${yearsSql})
    GROUP BY so.jurisdiction_province, EXTRACT(YEAR FROM a.created_at)::int
    ORDER BY 1, 2
  `);
  return normalizeRows(Array.from(rows));
}

// ---------------------------------------------------------------------------
// 6. Dimension definitions
// ---------------------------------------------------------------------------

type DimScope = "all" | "featured"; // "all" = featured + spot; "featured" = only Córdoba/Salta

type DimDef = {
  id: string;
  label: string;
  scope: DimScope;
  fetch: () => Promise<CellRow[]>;
};

const DIMS: DimDef[] = [
  // --- pet_events via pets JOIN ---
  {
    id: "pet_registered",
    label: "pet_registered (via pets JOIN)",
    scope: "all",
    fetch: () => queryPetEventsJoin("pet_registered"),
  },
  {
    id: "vaccination_rabies",
    label: "vaccination_administered (rabies, via pets JOIN)",
    scope: "all",
    fetch: () =>
      queryPetEventsJoin(
        "vaccination_administered",
        sql`unaccent(lower(coalesce(pe.payload->>'vaccine_name', ''))) LIKE '%rabi%'`,
      ),
  },
  {
    id: "sterilization_performed",
    label: "sterilization_performed (via pets JOIN)",
    scope: "all",
    fetch: () => queryPetEventsJoin("sterilization_performed"),
  },
  {
    id: "death_recorded",
    label: "death_recorded (via pets JOIN)",
    scope: "all",
    fetch: () => queryPetEventsJoin("death_recorded"),
  },
  {
    id: "adoption_finalized",
    label: "adoption_finalized (via pets JOIN)",
    scope: "all",
    fetch: () => queryPetEventsJoin("adoption_finalized"),
  },
  // --- pet_events via payload->>'province' ---
  {
    id: "outbreak_signal",
    label: "outbreak_signal (payload->>'province', loadZoonosisByUnit)",
    scope: "all",
    fetch: () => queryPetEventsPayload(sql`pe.event_type = 'outbreak_signal'`),
  },
  {
    id: "incident_reported_bite",
    label: "incident_reported bite (payload->>'province', loadMordedurassByUnit)",
    scope: "all",
    fetch: () =>
      queryPetEventsPayload(
        sql`pe.event_type = 'incident_reported' AND (pe.payload->>'incident_type') IN ('bite_inflicted', 'bite_suffered')`,
      ),
  },
  {
    id: "pet_lost",
    label: "pet_lost (payload->>'kind', payload->>'province', loadPerdidasByUnit)",
    scope: "all",
    fetch: () => queryPetEventsPayload(sql`(pe.payload->>'kind') = 'pet_lost'`),
  },
  // --- welfare_reports ---
  {
    id: "welfare_reports",
    label: "welfare_reports (jurisdiction_province, loadDenunciasByUnit)",
    scope: "featured",
    fetch: queryWelfareReports,
  },
  // --- cases ---
  {
    id: "custody_dispute",
    label: "cases case_kind='custody_dispute' (jurisdiction_province)",
    scope: "featured",
    fetch: () => queryCases("custody_dispute"),
  },
  {
    id: "custody_episode",
    label: "cases case_kind='custody_episode' (jurisdiction_province)",
    scope: "featured",
    fetch: () => queryCases("custody_episode"),
  },
  // --- campaigns ---
  {
    id: "campaigns",
    label: "appointments × service_offerings (jurisdiction_province, fetchCampaignDashboard)",
    scope: "featured",
    fetch: queryCampaigns,
  },
];

// The 8 pet_events dimensions that apply to spot-check provinces
const PET_EVENT_DIM_IDS = new Set([
  "pet_registered",
  "vaccination_rabies",
  "sterilization_performed",
  "death_recorded",
  "adoption_finalized",
  "outbreak_signal",
  "incident_reported_bite",
  "pet_lost",
]);

// ---------------------------------------------------------------------------
// 7. Run all queries
// ---------------------------------------------------------------------------

console.log("\n=== verify-history-coverage ===\n");
console.log(
  `Checking ${FEATURED_PROVINCES.join(", ")} (featured) × {${YEARS.join(", ")}} × 12 dimensions`,
);
console.log(
  `Spot-check: ${SPOT_PROVINCES.join(", ")} × {${YEARS.join(", ")}} × 8 pet_events dimensions`,
);
console.log("");

type DimResult = { def: DimDef; matrix: Matrix };
const results: DimResult[] = [];

for (const def of DIMS) {
  const rows = await def.fetch();
  results.push({ def, matrix: buildMatrix(rows) });
}

// ---------------------------------------------------------------------------
// 8. Print matrix
// ---------------------------------------------------------------------------

const COL_W = 7; // year column width
const DIM_W = 55; // dimension label width
const PROV_W = 18; // province column width

function padRight(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

function fmtCount(n: number): string {
  return n > 0 ? padLeft(n.toLocaleString("en-US"), COL_W) : padLeft("✗", COL_W);
}

const sep = `${"─".repeat(DIM_W + 1)}${`┬${"─".repeat(PROV_W + 1)}`}${YEARS.map(() => `┬${"─".repeat(COL_W + 1)}`).join("")}`;
const header = `${padRight("Dimension", DIM_W)} │ ${padRight("Province", PROV_W)} │${YEARS.map((y) => ` ${padLeft(String(y), COL_W)} `).join("│")}`;

console.log("─".repeat(sep.length));
console.log(header);
console.log(sep);

for (const { def, matrix } of results) {
  const provinceList = def.scope === "all" ? ALL_PROVINCES : FEATURED_PROVINCES;

  let firstRow = true;
  for (const prov of provinceList) {
    const dimLabel = firstRow ? padRight(def.label, DIM_W) : padRight("", DIM_W);
    firstRow = false;
    const counts = YEARS.map((y) => fmtCount(getCount(matrix, prov, y))).join(" │");
    console.log(`${dimLabel} │ ${padRight(prov, PROV_W)} │${counts}`);
  }
  console.log(sep);
}

// ---------------------------------------------------------------------------
// 9. Validate — collect failures
// ---------------------------------------------------------------------------

type FailingCell = { dim: string; province: string; year: Year; count: number };
const failures: FailingCell[] = [];

for (const { def, matrix } of results) {
  // Always check featured provinces for all applicable dimensions
  for (const prov of FEATURED_PROVINCES) {
    for (const year of YEARS) {
      const n = getCount(matrix, prov, year);
      if (n === 0) {
        failures.push({ dim: def.label, province: prov, year, count: 0 });
      }
    }
  }

  // Check spot-check provinces only for pet_events dimensions
  if (PET_EVENT_DIM_IDS.has(def.id)) {
    for (const prov of SPOT_PROVINCES) {
      for (const year of YEARS) {
        const n = getCount(matrix, prov, year);
        if (n === 0) {
          // Spot-check failures are warnings, not blockers
          console.log(`  [WARN] Spot-check: ${def.id} / ${prov} / ${year} = 0`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Report + exit
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.log("\n❌ BLOCKED — the following required cells are EMPTY:\n");
  for (const f of failures) {
    console.log(`  FAIL: ${f.dim}`);
    console.log(`        Province: ${f.province}  Year: ${f.year}  Count: 0`);
  }
  console.log(
    `\n${failures.length} cell(s) failed. Seed is incomplete — re-run pnpm seed:panorama.\n`,
  );
  process.exit(1);
} else {
  console.log("\n✓ All required Córdoba/Salta cells are non-zero across all 3 years.");
  console.log("✓ History coverage matrix: PASS\n");
  process.exit(0);
}
