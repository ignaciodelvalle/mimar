// place-legacy-grants — does any ACTIVE govt grant in CABA or Córdoba still
// match by its locality NAME instead of an authority unit?
//
// WHY (localidades CABA + Córdoba, 2026-10, change C4): in these two provinces
// grants are meant to live on authority units (lib/place/unit-first-provinces.ts).
// A grant is born legacy (`authority_unit_id IS NULL`, matched by its
// (province, locality) name pair) and is confirmed onto its unit in a second
// step, /admin/localidades/[unitId] → candidates. A forgotten second step is
// not harmless in Córdoba: seven pairs of towns share a name, so a legacy
// grant on San Pedro sees BOTH San Pedros. This check names every such grant.
//
// WHY A CHECK AND NOT A CONSTRAINT: a CHECK "an active AR-C/AR-X grant carries
// a unit" was considered and rejected — grants are born legacy by design
// (assign-govt-locality, create-institutional-account) and dozens of test
// fixtures create them; the constraint would force a rewrite of onboarding.
//
// READ-ONLY: one SELECT. Same refusal discipline as check-function-parity: an
// unreachable database, or a remote one without --allow-remote, is a FAILURE
// (exit 2), never a silent pass.
//
// Usage:
//   pnpm place:legacy-grants                                  (local stack)
//   DATABASE_URL=... pnpm place:legacy-grants -- --allow-remote [--json]
// Exit: 0 none, 1 at least one legacy grant (each one listed), 2 refused.

import path from "node:path";

import { config as loadEnv } from "dotenv";
import postgres from "postgres";

import { postgresTlsOption } from "../db/tls";
import { UNIT_FIRST_PROVINCE_CODES } from "../lib/place/unit-first-provinces";
import { DEFAULT_LOCAL_URL, describeTarget, lines, remoteSkipReason } from "./_db-target";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

export type LegacyGrant = {
  assignmentId: string;
  userId: string;
  provinceCode: string;
  province: string;
  locality: string;
};

type Client = ReturnType<typeof postgres>;

/** Every active grant in a unit-first province that is not on an authority unit. */
export async function findLegacyGrants(
  client: Client,
  provinceCodes: readonly string[] = UNIT_FIRST_PROVINCE_CODES,
): Promise<LegacyGrant[]> {
  const rows = await client<LegacyGrant[]>`
    select g.id::text as "assignmentId", g.user_id::text as "userId",
           public.ar_province_code(g.jurisdiction_province) as "provinceCode",
           g.jurisdiction_province as province, g.jurisdiction_locality as locality
      from public.govt_assignments g
     where g.revoked_at is null
       and g.authority_unit_id is null
       and public.ar_province_code(g.jurisdiction_province) = any(${[...provinceCodes]})
     order by 3, 5, 1
  `;
  return [...rows];
}

/** The report lines for a result; empty means clean. */
export function describeLegacyGrants(grants: readonly LegacyGrant[]): string[] {
  return grants.map(
    (g) =>
      `${g.provinceCode} ${g.locality || "(toda la provincia)"} — grant ${g.assignmentId} (user ${g.userId}) matches by name, not by unit`,
  );
}

export async function runLegacyGrantCheck(argv: string[] = []): Promise<void> {
  const allowRemote = argv.includes("--allow-remote");
  const rawUrl = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  const target = describeTarget(rawUrl);
  const remote = remoteSkipReason(target, allowRemote);
  if (remote !== null) {
    console.error(`✗ place-legacy-grants refused: ${remote}`);
    console.error(`  Database looked at: ${target.label}`);
    console.error(
      lines(
        "  Auditing a remote database has to be deliberate. This script is read-only (one SELECT).",
        "    DATABASE_URL=... pnpm place:legacy-grants -- --allow-remote",
      ),
    );
    process.exit(2);
  }

  const client = postgres(rawUrl, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
    ssl: postgresTlsOption(rawUrl),
  });
  try {
    let grants: LegacyGrant[];
    try {
      grants = await findLegacyGrants(client);
    } catch (err) {
      console.error(
        `✗ place-legacy-grants could not read ${target.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(2);
    }
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ database: target.label, legacyGrants: grants }, null, 2));
    } else {
      console.log(`\nplace-legacy-grants — ${target.label}\n`);
      if (grants.length === 0) {
        console.log(
          `✓ no active name-matched grant in ${UNIT_FIRST_PROVINCE_CODES.join(", ")} — every one is on its unit.`,
        );
      } else {
        console.error(`✗ ${grants.length} active grant(s) still match by name:`);
        for (const line of describeLegacyGrants(grants)) console.error(`    ${line}`);
        console.error(
          "  Confirm each onto its unit: /admin/localidades/[unitId] → candidatos (a draft unit is confirmed first).",
        );
      }
    }
    if (grants.length > 0) process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("place-legacy-grants.ts");
if (isMain) {
  runLegacyGrantCheck(process.argv.slice(2));
}
