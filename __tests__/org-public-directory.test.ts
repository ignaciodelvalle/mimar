// The public directory at /refugios — "Refugios y veterinarias" (PO 2026-10-02,
// migration 0283).
//
// Against the local database:
//   - the column exists, NOT NULL, default false, and re-running 0283 is a no-op;
//   - audit_log accepts the action that records a switch of the setting;
//   - a verified clinic is NOT listed until it opts in, IS listed after, and
//     leaves when it opts out; an unverified clinic is never listed, opted in
//     or not; a sanitary authority or an "other" org is never listed even with
//     the column set; shelters and rescue networks stay listed as before;
//     a suspended or dissolved org is never listed, whatever else is true;
//   - the profile gate (queryOrgPublicProfile) answers the same as the list;
//   - a listed clinic's profile withholds its legal name (a solo vet's own
//     name) and its coordinates (disclose_address defaults to true, and no
//     form lets a clinic choose it); a shelter's profile is unchanged;
//   - the SQL predicate and its pure twin agree on every fixture;
//   - the directory row carries the five public fields and nothing else — no
//     email, no phone, no CUIT;
//   - the anonymous surface 0278-0280 closed stays closed: PostgREST with the
//     publishable key reads nothing of the opted-in clinic the list shows,
//     and neither does anon under deploy-provision's blanket re-grant.
// And, pure: the URL filters (type, province) parse defensively and filter.
//
// Seeded rows carry their own tokens and are deleted before and after (the
// local database is shared by every worktree).

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations } from "@/db";
import { queryPublicDirectory } from "@/lib/infra/org-directory";
import { queryOrgPublicProfile } from "@/lib/infra/org-public-profile";
import {
  applyDirectoryFilters,
  directorySearch,
  isListedInPublicDirectory,
  parseDirectoryFilters,
} from "@/src/modules/organizations/domain/public-directory";

import { inRolledBackTx, rows } from "./_helpers/erasure-tx";

const MIGRATION = readFileSync("db/migrations/0283_org_public_directory_opt_in.sql", "utf8");

type Fixture = {
  publicToken: string;
  orgType: "clinic" | "shelter" | "rescue_network" | "sanitary_authority" | "other";
  verified: boolean;
  status?: "active" | "suspended" | "dissolved";
  publicDirectoryOptIn?: boolean;
  autoVerifiedViaMatricula?: boolean;
};

const CLINIC_DEFAULT = "DIM-DIRV-CLD1"; // verified clinic, column left to its default
const CLINIC_OPTED = "DIM-DIRV-CLO1"; // verified clinic, opted in
const CLINIC_UNVERIFIED = "DIM-DIRV-CLU1"; // unverified clinic, opted in
const SHELTER = "DIM-DIRV-SHE1";
const RESCUE = "DIM-DIRV-RES1";
const AUTHORITY = "DIM-DIRV-AUT1"; // verified, column set — still not listable
const OTHER = "DIM-DIRV-OTH1";
const CLINIC_SUSPENDED = "DIM-DIRV-CLS1"; // verified, opted in, suspended
const SHELTER_DISSOLVED = "DIM-DIRV-SHD1"; // verified shelter, dissolved

const FIXTURES: Fixture[] = [
  { publicToken: CLINIC_DEFAULT, orgType: "clinic", verified: true },
  {
    publicToken: CLINIC_OPTED,
    orgType: "clinic",
    verified: true,
    publicDirectoryOptIn: true,
    autoVerifiedViaMatricula: true,
  },
  {
    publicToken: CLINIC_UNVERIFIED,
    orgType: "clinic",
    verified: false,
    publicDirectoryOptIn: true,
  },
  { publicToken: SHELTER, orgType: "shelter", verified: true },
  { publicToken: RESCUE, orgType: "rescue_network", verified: true },
  {
    publicToken: AUTHORITY,
    orgType: "sanitary_authority",
    verified: true,
    publicDirectoryOptIn: true,
  },
  { publicToken: OTHER, orgType: "other", verified: true, publicDirectoryOptIn: true },
  {
    publicToken: CLINIC_SUSPENDED,
    orgType: "clinic",
    verified: true,
    status: "suspended",
    publicDirectoryOptIn: true,
  },
  { publicToken: SHELTER_DISSOLVED, orgType: "shelter", verified: true, status: "dissolved" },
];
const TOKENS = FIXTURES.map((f) => f.publicToken);

async function cleanup() {
  await db.delete(organizations).where(inArray(organizations.publicToken, TOKENS));
}

async function listedTokens(): Promise<Set<string>> {
  const all = await queryPublicDirectory();
  return new Set(all.map((r) => r.publicToken).filter((t) => TOKENS.includes(t)));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(organizations).values(
    FIXTURES.map((f) => ({
      publicToken: f.publicToken,
      legalName: `Razon social ${f.publicToken}`,
      // "AAA…" in the first province sorts these rows ahead of the real
      // roster under the read's ORDER BY province, name — the LIMIT can never
      // cut them.
      displayName: `AAA Directorio ${f.publicToken}`,
      orgType: f.orgType,
      verified: f.verified,
      // Contact fields set on purpose: the privacy test proves the list
      // never carries them.
      email: `${f.publicToken.toLowerCase()}@dim-test.local`,
      phone: "+54 11 5555-0000",
      cuit: null,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      // Coordinates on every row, disclose_address left to its default
      // (true): only the clinic rule may hide the clinic's pin.
      locationLat: "-34.9214500",
      locationLng: "-57.9545300",
      ...(f.status !== undefined && { status: f.status }),
      ...(f.autoVerifiedViaMatricula !== undefined && {
        autoVerifiedViaMatricula: f.autoVerifiedViaMatricula,
      }),
      ...(f.publicDirectoryOptIn !== undefined && { publicDirectoryOptIn: f.publicDirectoryOptIn }),
    })),
  );
});

afterAll(cleanup);

describe("migration 0283 — organizations.public_directory_opt_in", () => {
  it("is a NOT NULL boolean defaulting to false", async () => {
    const [col] = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(sql`
      select data_type, is_nullable, column_default
        from information_schema.columns
       where table_schema = 'public' and table_name = 'organizations'
         and column_name = 'public_directory_opt_in'`);
    expect(col).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "false" });
  });

  it("starts an org that never touched the setting unlisted", async () => {
    const [row] = await db
      .select({ optIn: organizations.publicDirectoryOptIn })
      .from(organizations)
      .where(eq(organizations.publicToken, CLINIC_DEFAULT));
    expect(row?.optIn).toBe(false);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const after = await inRolledBackTx(async (tx) => {
      await tx.execute(sql.raw(MIGRATION));
      return rows(
        tx,
        sql`select public_directory_opt_in as opt_in from public.organizations
             where public_token = ${CLINIC_OPTED}`,
      );
    });
    expect(after).toEqual([{ opt_in: true }]);
  });
});

describe("migration 0283 — the opt-in switch is auditable", () => {
  it("lets audit_log accept org_public_directory_opt_in_changed (rolled back)", async () => {
    const inserted = await inRolledBackTx(async (tx) =>
      rows(
        tx,
        sql`insert into public.audit_log (action, target_organization_id, payload)
             select 'org_public_directory_opt_in_changed', id,
                    jsonb_build_object('org_id', id,
                      'before_values', jsonb_build_object('public_directory_opt_in', false),
                      'after_values', jsonb_build_object('public_directory_opt_in', true))
               from public.organizations where public_token = ${CLINIC_OPTED}
             returning action`,
      ),
    );
    expect(inserted).toEqual([{ action: "org_public_directory_opt_in_changed" }]);
  });
});

describe("queryPublicDirectory — who is listed", () => {
  it("lists verified shelters, rescue networks and opted-in verified clinics — nothing else", async () => {
    expect([...(await listedTokens())].sort()).toEqual([CLINIC_OPTED, RESCUE, SHELTER].sort());
  });

  it("hides a verified clinic until it opts in, shows it after, hides it again on opt-out", async () => {
    expect((await listedTokens()).has(CLINIC_DEFAULT)).toBe(false);

    await db
      .update(organizations)
      .set({ publicDirectoryOptIn: true })
      .where(eq(organizations.publicToken, CLINIC_DEFAULT));
    expect((await listedTokens()).has(CLINIC_DEFAULT)).toBe(true);
    expect(await queryOrgPublicProfile(CLINIC_DEFAULT)).not.toBeNull();

    await db
      .update(organizations)
      .set({ publicDirectoryOptIn: false })
      .where(eq(organizations.publicToken, CLINIC_DEFAULT));
    expect((await listedTokens()).has(CLINIC_DEFAULT)).toBe(false);
    expect(await queryOrgPublicProfile(CLINIC_DEFAULT)).toBeNull();
  });

  it("agrees with the pure predicate on every fixture", async () => {
    const listed = await listedTokens();
    for (const f of FIXTURES) {
      const pure = isListedInPublicDirectory({
        orgType: f.orgType,
        verified: f.verified,
        status: f.status ?? "active",
        publicDirectoryOptIn: f.publicDirectoryOptIn ?? false,
      });
      expect({ token: f.publicToken, listed: listed.has(f.publicToken) }).toEqual({
        token: f.publicToken,
        listed: pure,
      });
    }
  });
});

describe("queryOrgPublicProfile — the profile answers like the list", () => {
  it("serves the opted-in verified clinic as a clinic", async () => {
    const profile = await queryOrgPublicProfile(CLINIC_OPTED);
    expect(profile?.orgType).toBe("clinic");
  });

  it("404s every org the directory does not list", async () => {
    for (const token of [
      CLINIC_DEFAULT,
      CLINIC_UNVERIFIED,
      AUTHORITY,
      OTHER,
      CLINIC_SUSPENDED,
      SHELTER_DISSOLVED,
    ]) {
      expect(await queryOrgPublicProfile(token)).toBeNull();
    }
  });
});

describe("privacy — a listed clinic's profile withholds what it never consented to", () => {
  it("serves no legal name and no coordinates for the clinic", async () => {
    const clinic = await queryOrgPublicProfile(CLINIC_OPTED);
    expect(clinic).not.toBeNull();
    expect(clinic?.legalName).toBeNull();
    expect(clinic?.latitude).toBeNull();
    expect(clinic?.longitude).toBeNull();
    expect(JSON.stringify(clinic)).not.toContain("Razon social");
  });

  it("leaves a shelter's legal name and disclosed pin as they were", async () => {
    const shelter = await queryOrgPublicProfile(SHELTER);
    expect(shelter?.legalName).toBe(`Razon social ${SHELTER}`);
    expect(shelter?.latitude).toBeCloseTo(-34.92145, 5);
    expect(shelter?.longitude).toBeCloseTo(-57.95453, 5);
  });

  it("names the verifying institution, never a person", async () => {
    expect((await queryOrgPublicProfile(CLINIC_OPTED))?.verifiedVia).toBe("matricula");
    expect((await queryOrgPublicProfile(SHELTER))?.verifiedVia).toBe("mimar_team");
  });
});

describe("privacy — the directory row is public-safe by construction", () => {
  it("carries exactly the five public fields", async () => {
    const row = (await queryPublicDirectory()).find((r) => r.publicToken === CLINIC_OPTED);
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "displayName",
        "jurisdictionLocality",
        "jurisdictionProvince",
        "orgType",
        "publicToken",
      ].sort(),
    );
    // Belt and braces: the seeded email and phone appear nowhere in the payload.
    const serialized = JSON.stringify(await queryPublicDirectory());
    expect(serialized).not.toContain("@dim-test.local");
    expect(serialized).not.toContain("5555-0000");
  });
});

// The directory is a server-side projection (Drizzle, BYPASSRLS) and must
// stay one. 0278-0280 closed every anonymous read of organizations; this
// feature reopens none of it. Proven on the opted-in clinic — the exact row
// the directory DOES list — so a closed probe cannot be a probe of nothing.
describe("anon surface — the directory reopens no anonymous read (0278-0280)", () => {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

  /** Thrown to force the rollback of a probe transaction; carries its result. */
  class Rollback extends Error {
    constructor(readonly result: unknown[]) {
      super("rollback");
    }
  }

  /** `statement` as anon, after deploy-provision's blanket re-grant; always rolled back. */
  async function asAnonUnderRegrant(statement: ReturnType<typeof sql>): Promise<unknown[]> {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`GRANT ALL ON public.organizations TO anon`);
        await tx.execute(sql`SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        await tx.execute(sql`SET LOCAL ROLE anon`);
        throw new Rollback((await tx.execute(statement)) as unknown as unknown[]);
      });
    } catch (err) {
      if (err instanceof Rollback) return err.result;
      throw err;
    }
    throw new Error("unreachable: the probe transaction must roll back");
  }

  it("positive control: the directory lists the opted-in clinic", async () => {
    expect((await listedTokens()).has(CLINIC_OPTED)).toBe(true);
  });

  it("PostgREST with the publishable key reads nothing of it — zero rows or a denial", async () => {
    if (!SUPABASE_URL || !ANON_KEY) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing — no PostgREST to probe.",
      );
    }
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    for (const columns of ["id", "id,display_name,public_directory_opt_in", "*"]) {
      const { data, error } = await anon
        .from("organizations")
        .select(columns)
        .eq("public_token", CLINIC_OPTED);
      // A rejected CREDENTIAL is not a denial: only 42501 (privilege) counts.
      if (error) expect({ columns, code: error.code }).toEqual({ columns, code: "42501" });
      else expect({ columns, rows: data }).toEqual({ columns, rows: [] });
    }
  });

  it("anon reads zero rows even under the provisioner's re-grant", async () => {
    const rows = await asAnonUnderRegrant(
      sql`SELECT id, public_directory_opt_in FROM public.organizations
           WHERE public_token = ${CLINIC_OPTED}`,
    );
    expect(rows).toEqual([]);
  });
});

describe("directory URL filters (pure)", () => {
  const PROVINCES = ["Buenos Aires", "CABA", "Córdoba"];
  const ROWS = [
    { orgType: "shelter", jurisdictionProvince: "CABA" },
    { orgType: "rescue_network", jurisdictionProvince: "Córdoba" },
    { orgType: "clinic", jurisdictionProvince: "CABA" },
    { orgType: "clinic", jurisdictionProvince: null },
  ];

  it("reads tipo and provincia, and drops what it does not know", () => {
    expect(parseDirectoryFilters({ tipo: "veterinarias", provincia: "CABA" }, PROVINCES)).toEqual({
      kind: "veterinarias",
      province: "CABA",
    });
    expect(parseDirectoryFilters({ tipo: "Refugios" }, PROVINCES)).toEqual({
      kind: "refugios",
      province: null,
    });
    expect(parseDirectoryFilters({ tipo: "gatos", provincia: "Narnia" }, PROVINCES)).toEqual({
      kind: null,
      province: null,
    });
    expect(parseDirectoryFilters({ tipo: ["veterinarias", "refugios"] }, PROVINCES).kind).toBe(
      "veterinarias",
    );
    expect(parseDirectoryFilters({}, PROVINCES)).toEqual({ kind: null, province: null });
  });

  it("filters by type — refugios means shelters AND rescue networks", () => {
    expect(applyDirectoryFilters(ROWS, { kind: "refugios", province: null })).toEqual([
      ROWS[0],
      ROWS[1],
    ]);
    expect(applyDirectoryFilters(ROWS, { kind: "veterinarias", province: null })).toEqual([
      ROWS[2],
      ROWS[3],
    ]);
    expect(applyDirectoryFilters(ROWS, { kind: null, province: null })).toEqual(ROWS);
  });

  it("filters by province, combined with type", () => {
    expect(applyDirectoryFilters(ROWS, { kind: null, province: "CABA" })).toEqual([
      ROWS[0],
      ROWS[2],
    ]);
    expect(applyDirectoryFilters(ROWS, { kind: "veterinarias", province: "CABA" })).toEqual([
      ROWS[2],
    ]);
    expect(applyDirectoryFilters(ROWS, { kind: "refugios", province: "Buenos Aires" })).toEqual([]);
  });

  it("writes the filters back as a query string", () => {
    expect(directorySearch({ kind: null, province: null })).toBe("");
    expect(directorySearch({ kind: "veterinarias", province: "Córdoba" })).toBe(
      "?tipo=veterinarias&provincia=C%C3%B3rdoba",
    );
  });
});
