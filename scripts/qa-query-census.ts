/**
 * Per-page DB query census against the production server at :3001.
 *
 * For each (role, route): resets pg_stat_statements, requests the route 3x,
 * then counts the calls issued by the APP's connection role (postgres — the
 * drizzle pool user; GoTrue/PostgREST run as other roles, so auth-layer noise
 * is excluded by construction). The census's own psql statements are excluded
 * by filtering out pg_stat% queries.
 *
 * Usage: pnpm exec tsx scripts/qa-query-census.ts
 */

import { execSync } from "node:child_process";

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

const BASE = "http://localhost:3001";
const HITS = 3;

function psql(sql: string): string {
  const cmd = `docker exec -e PGPASSWORD=postgres supabase_db_DIM psql -U postgres -d postgres -t -A -c "${sql.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

async function getCookie(email: string): Promise<string> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
  );
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: "Test1234!",
  });
  if (error || !data.session) throw new Error(`sign-in failed: ${email}`);
  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, email, "Test1234!");
  const session = (await supabase.auth.getSession()).data.session ?? data.session;
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
  return `sb-${ref}-auth-token=${JSON.stringify(session)}`;
}

const APP_CALLS_SQL = `SELECT coalesce(sum(calls),0) FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid WHERE r.rolname = 'postgres' AND s.query NOT ILIKE '%pg_stat%' AND s.query NOT ILIKE '%pg_roles%'`;

async function censusPage(label: string, route: string, cookie?: string) {
  psql("SELECT pg_stat_statements_reset()");
  for (let i = 0; i < HITS; i++) {
    const resp = await fetch(`${BASE}${route}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: "manual",
    });
    await resp.text();
    if (resp.status !== 200) {
      console.log(`${label} ${route} -> HTTP ${resp.status} (aborting census for this page)`);
      return;
    }
  }
  const total = Number(psql(APP_CALLS_SQL));
  console.log(
    `${label.padEnd(12)} ${route.padEnd(45)} ${String(total).padStart(4)} calls / ${HITS} hits = ${(total / HITS).toFixed(1)} queries/page`,
  );
}

async function main() {
  const owner = await getCookie("owner@dim.test");
  const govt = await getCookie("govt-local@dim.test");
  const admin = await getCookie("admin@dim.test");
  const org = await getCookie("orgadmin@dim.test");

  // Warm-up pass so compile/connection setup does not pollute the census.
  for (const [r, c] of [
    ["/inicio", owner],
    ["/cuenta", owner],
    ["/mis-mascotas/DIM-ZHF8-3K4G", owner],
    ["/gob", govt],
    ["/admin", admin],
    ["/org/DIM-D7MW-HHPE", org],
  ] as const) {
    await fetch(`${BASE}${r}`, { headers: { Cookie: c } }).then((x) => x.text());
  }

  await censusPage("owner", "/inicio", owner);
  await censusPage("owner", "/cuenta", owner);
  await censusPage("owner", "/mis-mascotas", owner);
  await censusPage("owner", "/mis-mascotas/DIM-ZHF8-3K4G", owner);
  await censusPage("owner", "/notificaciones", owner);
  await censusPage("govt", "/gob", govt);
  await censusPage("govt", "/gob/maltrato", govt);
  await censusPage("admin", "/admin", admin);
  await censusPage("org", "/org/DIM-D7MW-HHPE", org);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
