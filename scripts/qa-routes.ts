/**
 * Click-through QA runner for MiMAR.
 *
 * Usage: pnpm exec tsx scripts/qa-routes.ts
 *
 * Reads credentials from env vars (set by harness):
 *   QA_OWNER_EMAIL / QA_OWNER_PASSWORD
 *   QA_VET_EMAIL / QA_VET_PASSWORD
 *
 * Prints a structured report to stdout.
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

const BASE = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

const MAX_CHUNK_SIZE = 3180;

function createChunks(key: string, value: string): Array<{ name: string; value: string }> {
  let encodedValue = encodeURIComponent(value);
  if (encodedValue.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }];
  }
  const chunks: string[] = [];
  while (encodedValue.length > 0) {
    let encodedChunkHead = encodedValue.slice(0, MAX_CHUNK_SIZE);
    const lastEscapePos = encodedChunkHead.lastIndexOf("%");
    if (lastEscapePos > MAX_CHUNK_SIZE - 3) {
      encodedChunkHead = encodedChunkHead.slice(0, lastEscapePos);
    }
    let valueHead = "";
    while (encodedChunkHead.length > 0) {
      try {
        valueHead = decodeURIComponent(encodedChunkHead);
        break;
      } catch (e) {
        if (
          e instanceof URIError &&
          encodedChunkHead.at(-3) === "%" &&
          encodedChunkHead.length > 3
        ) {
          encodedChunkHead = encodedChunkHead.slice(0, encodedChunkHead.length - 3);
        } else {
          throw e;
        }
      }
    }
    chunks.push(valueHead);
    encodedValue = encodedValue.slice(encodedChunkHead.length);
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }));
}

async function getCookie(email: string, password: string): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Sign-in failed for ${email}: ${error?.message}`);
  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, email, password);
  const session = (await supabase.auth.getSession()).data.session ?? data.session;

  const url = new URL(supabaseUrl);
  const projectRef = url.hostname.split(".")[0];
  const cookieKey = `sb-${projectRef}-auth-token`;
  const sessionJson = JSON.stringify(session);
  const pairs = createChunks(cookieKey, sessionJson);
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}

// ---------------------------------------------------------------------------
// Route checker
// ---------------------------------------------------------------------------

type RouteResult = {
  audience: string;
  route: string;
  status: number;
  redirectTo?: string;
  verdict: "OK" | "FINDING";
  detail?: string;
};

const results: RouteResult[] = [];

async function check(
  audience: string,
  route: string,
  opts: {
    cookie?: string;
    expectedStatus?: number | number[];
    mustContain?: string[];
    mustNotContain?: string[];
    expectRedirectContains?: string;
    note?: string;
  } = {},
): Promise<{ status: number; body: string; redirectTo: string }> {
  const url = `${BASE}${route}`;
  const {
    cookie,
    expectedStatus = 200,
    mustContain = [],
    mustNotContain = [],
    expectRedirectContains,
    note,
  } = opts;

  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;

  let status = 0;
  let body = "";
  let redirectTo = "";
  let fetchError: string | undefined;

  try {
    const resp = await fetch(url, { headers, redirect: "manual" });
    status = resp.status;
    redirectTo = resp.headers.get("location") ?? "";

    if (status === 200) {
      body = await resp.text();
    }
  } catch (e: unknown) {
    fetchError = String(e);
    status = -1;
  }

  const expectedStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  const statusOk = expectedStatuses.includes(status);

  const findings: string[] = [];

  if (fetchError) findings.push(`fetch error: ${fetchError}`);
  if (!statusOk) findings.push(`expected HTTP ${expectedStatuses.join("/")} got ${status}`);

  if (expectRedirectContains && !redirectTo.includes(expectRedirectContains)) {
    findings.push(`expected redirect containing "${expectRedirectContains}", got "${redirectTo}"`);
  }

  for (const marker of mustContain) {
    if (!body.includes(marker)) {
      findings.push(`missing content marker: "${marker}"`);
    }
  }
  for (const marker of mustNotContain) {
    if (body.includes(marker)) {
      findings.push(`unexpected content: "${marker}"`);
    }
  }

  // Detect real Next.js error boundaries (not RSC streaming payloads which also contain "digest")
  if (
    body.includes("Application error") ||
    body.includes("__NEXT_ERROR__") ||
    (body.includes("digest") &&
      body.includes("Application error") &&
      !body.includes('"digest":"$undefined"'))
  ) {
    findings.push("Next.js error boundary detected in HTML");
  }

  if (status === 500) findings.push("HTTP 500 — server error");

  const verdict: "OK" | "FINDING" = findings.length === 0 ? "OK" : "FINDING";
  const parts = [];
  if (note) parts.push(note);
  parts.push(...findings);
  const detail = parts.length > 0 ? parts.join("; ") : undefined;

  const result: RouteResult = {
    audience,
    route,
    status,
    redirectTo: redirectTo || undefined,
    verdict,
    detail,
  };
  results.push(result);
  return { status, body, redirectTo };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ownerEmail = process.env.QA_OWNER_EMAIL ?? "owner@dim.test";
  const ownerPassword = process.env.QA_OWNER_PASSWORD ?? "Test1234!";
  const vetEmail = process.env.QA_VET_EMAIL ?? "vet@dim.test";
  const vetPassword = process.env.QA_VET_PASSWORD ?? "Test1234!";

  console.error("[qa-routes] Signing in test users...");
  const ownerCookie = await getCookie(ownerEmail, ownerPassword);
  console.error(`[qa-routes] Owner cookie obtained (${ownerCookie.length} chars)`);
  const vetCookie = await getCookie(vetEmail, vetPassword);
  console.error(`[qa-routes] Vet cookie obtained (${vetCookie.length} chars)`);

  // Validate cookies
  const ownerValidation = await fetch(`${BASE}/inicio`, {
    headers: { Cookie: ownerCookie },
    redirect: "manual",
  });
  console.error(
    `[qa-routes] Owner cookie validation: /inicio => ${ownerValidation.status} ${ownerValidation.headers.get("location") ?? ""}`,
  );

  console.error("[qa-routes] Starting route checks...\n");

  // =========================================================================
  // ANONYMOUS routes
  // =========================================================================

  // / — landing
  const homeResult = await check("anon", "/", {
    expectedStatus: 200,
    mustContain: ["/perdidas", "/adoptar"],
  });

  await check("anon", "/perdidas", { expectedStatus: 200 });
  await check("anon", "/refugios", { expectedStatus: 200 });
  await check("anon", "/adoptar", { expectedStatus: 200 });
  await check("anon", "/denuncias/nueva", { expectedStatus: 200 });

  // /login — email input before Mi Argentina stub
  await check("anon", "/login", {
    expectedStatus: 200,
    mustContain: ["email"],
  });

  // /signup — email input before Mi Argentina stub
  await check("anon", "/signup", {
    expectedStatus: 200,
    mustContain: ["email"],
  });

  // /login and /signup: check DOM order of email input vs Mi Argentina
  for (const route of ["/login", "/signup"]) {
    const resp = await fetch(`${BASE}${route}`, { redirect: "follow" });
    const html = await resp.text();
    const emailPos = html.indexOf('type="email"');
    const miArgentinaPos = html.indexOf("Mi Argentina");
    if (emailPos === -1) {
      results.push({
        audience: "anon",
        route: `${route} (DOM order)`,
        status: 200,
        verdict: "FINDING",
        detail: "No email input found in HTML",
      });
    } else if (miArgentinaPos !== -1 && emailPos > miArgentinaPos) {
      results.push({
        audience: "anon",
        route: `${route} (DOM order)`,
        status: 200,
        verdict: "FINDING",
        detail: `email input (pos ${emailPos}) appears AFTER Mi Argentina (pos ${miArgentinaPos}) — should be before`,
      });
    } else {
      results.push({
        audience: "anon",
        route: `${route} (DOM order)`,
        status: 200,
        verdict: "OK",
        detail:
          miArgentinaPos === -1
            ? "Mi Argentina stub not in DOM (not rendered yet)"
            : `email input (pos ${emailPos}) before Mi Argentina (pos ${miArgentinaPos})`,
      });
    }
  }

  // /privacidad
  await check("anon", "/privacidad", {
    expectedStatus: 200,
    mustContain: ["/cuenta/privacidad"],
    mustNotContain: ["registrada ante la DNPDP", "cumple las obligaciones de registro"],
  });

  // /terminos
  await check("anon", "/terminos", { expectedStatus: [200, 404] });

  // Protected routes must NOT be accessible anonymously
  for (const route of ["/gob", "/admin", "/inicio", "/cuenta"]) {
    await check("anon", route, {
      expectedStatus: [302, 303, 307, 308, 404],
      expectRedirectContains: route === "/gob" || route === "/admin" ? "/login" : "/login",
    });
  }

  // 404 for fake case (not 500)
  await check("anon", "/casos/SOMETHING-FAKE", { expectedStatus: 404 });

  // =========================================================================
  // /refugios deep check
  // =========================================================================

  // Fetch /refugios to extract an org token
  let refugioOrgToken: string | null = null;
  {
    const resp = await fetch(`${BASE}/refugios`, { redirect: "follow" });
    const html = await resp.text();
    const match = html.match(/href="\/refugios\/([A-Z0-9-]+)"/);
    if (match) {
      refugioOrgToken = match[1];
      // Verify /refugios/<token> link format exists
      results.push({
        audience: "anon",
        route: "/refugios (link format)",
        status: 200,
        verdict: "OK",
        detail: `Found org link /refugios/${refugioOrgToken}`,
      });
    } else {
      results.push({
        audience: "anon",
        route: "/refugios (link format)",
        status: 200,
        verdict: "FINDING",
        detail:
          "No /refugios/<token> links found in HTML — no verified orgs seeded or wrong URL format",
      });
    }
  }

  if (refugioOrgToken) {
    await check("anon", `/refugios/${refugioOrgToken}`, {
      expectedStatus: 200,
      note: `org detail for token ${refugioOrgToken}`,
    });
  }

  // =========================================================================
  // OWNER routes
  // =========================================================================

  // /inicio
  const inicioR = await check("owner", "/inicio", {
    cookie: ownerCookie,
    expectedStatus: 200,
    mustContain: ["Mis mascotas"],
  });

  // Sections check: Vencimientos/Próximos turnos
  {
    const resp = await fetch(`${BASE}/inicio`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    const hasVencimientos = html.includes("Vencimientos");
    const hasProximosTurnos = html.includes("Próximos turnos");
    const reminderLinkMatch = /<a\s[^>]*href="[^"]*tab=vacunas[^"]*"/.test(html);
    const hasReminderSection = html.includes("DueRow") || hasVencimientos;

    const sections = [];
    if (hasVencimientos) sections.push("Vencimientos");
    if (hasProximosTurnos) sections.push("Próximos turnos");

    // UI-P2: if Vencimientos section exists, rows must be links
    if (hasVencimientos && !reminderLinkMatch) {
      results.push({
        audience: "owner",
        route: "/inicio (reminder links UI-P2)",
        status: 200,
        verdict: "FINDING",
        detail:
          "Vencimientos section renders but reminder rows are NOT <a href> links — fails UI-P2",
      });
    } else {
      results.push({
        audience: "owner",
        route: "/inicio (sections)",
        status: 200,
        verdict: "OK",
        detail: `Sections present: ${sections.join(", ") || "none (no data)"}, reminder links: ${reminderLinkMatch}`,
      });
    }
  }

  // /mis-mascotas
  const misMascotasR = await check("owner", "/mis-mascotas", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });

  // Extract pet tokens
  let petTokens: string[] = [];
  {
    const resp = await fetch(`${BASE}/mis-mascotas`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    const matches = [...html.matchAll(/href="\/mis-mascotas\/([A-Z0-9-]+)"/g)];
    const allTokens = [...new Set(matches.map((m) => m[1]))];
    // Filter out nav/action paths
    petTokens = allTokens.filter((t) => !["nueva", "reclamar", "reclamar-dni"].includes(t));

    results.push({
      audience: "owner",
      route: "/mis-mascotas (pet count)",
      status: 200,
      verdict: petTokens.length >= 3 ? "OK" : "FINDING",
      detail: `Found ${petTokens.length} pet token(s) (expected 3): ${petTokens.join(", ")}`,
    });
  }

  // Check each pet detail page (max 3)
  for (const token of petTokens.slice(0, 3)) {
    await check("owner", `/mis-mascotas/${token}`, {
      cookie: ownerCookie,
      expectedStatus: 200,
      note: `pet detail ${token}`,
    });

    await check("owner", `/mis-mascotas/${token}?tab=vacunas`, {
      cookie: ownerCookie,
      expectedStatus: 200,
      note: `pet ${token} vacunas tab (libreta)`,
    });
  }

  // /mis-turnos
  await check("owner", "/mis-turnos", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });

  // /notificaciones
  const notifR = await check("owner", "/notificaciones", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });
  // Check tab/category chips
  {
    const resp = await fetch(`${BASE}/notificaciones`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    const hasChips = html.includes("tab") || html.includes("chip") || html.includes("categor");
    results.push({
      audience: "owner",
      route: "/notificaciones (chips)",
      status: 200,
      verdict: "OK",
      detail: `tab/chip elements present: ${hasChips}`,
    });
  }

  // /cuenta
  await check("owner", "/cuenta", {
    cookie: ownerCookie,
    expectedStatus: 200,
    mustContain: ["/notificaciones"],
  });

  // DNI copy check: should say "declarado" not "verificado" for owner
  {
    const resp = await fetch(`${BASE}/cuenta`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    // The DNI section should use "declarado" language
    const declaradoPos = html.indexOf("declarado");
    const verificadoNonMatriculaPos = (() => {
      // Find "verificado" NOT in "Matrícula ... verificada" context
      const idx = html.indexOf("verificado");
      if (idx === -1) return -1;
      const context = html.slice(Math.max(0, idx - 100), idx + 100);
      if (
        context.toLowerCase().includes("matrícula") ||
        context.toLowerCase().includes("matricula")
      )
        return -1;
      return idx;
    })();
    const dniFinding = verificadoNonMatriculaPos !== -1;

    results.push({
      audience: "owner",
      route: "/cuenta (DNI copy)",
      status: 200,
      verdict: dniFinding ? "FINDING" : "OK",
      detail: dniFinding
        ? `DNI section uses "verificado" (non-matricula context at pos ${verificadoNonMatriculaPos}) — should say "declarado/Declarar"`
        : `DNI copy OK — "declarado" present: ${declaradoPos !== -1}`,
    });
  }

  // /cuenta/privacidad
  await check("owner", "/cuenta/privacidad", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });

  // /cuenta/upgrade
  await check("owner", "/cuenta/upgrade", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });

  // /mis-mascotas/nueva
  await check("owner", "/mis-mascotas/nueva", {
    cookie: ownerCookie,
    expectedStatus: 200,
  });

  // Owner must NOT access /gob, /admin
  for (const route of ["/gob", "/admin"]) {
    const r = await check("owner", route, {
      cookie: ownerCookie,
      expectedStatus: [302, 303, 307, 308, 404],
    });
    if (r.status === 200) {
      // Override verdict
      const last = results[results.length - 1];
      last.verdict = "FINDING";
      last.detail = `Owner can access ${route} — should be denied`;
    }
  }

  // Owner must NOT access /org/DIM-ZCA5-7Z9W
  await check("owner", "/org/DIM-ZCA5-7Z9W", {
    cookie: ownerCookie,
    expectedStatus: [302, 303, 307, 308, 404, 403],
    note: "org access should be denied for owner",
  });

  // Public credential /p/<token>
  {
    const resp = await fetch(`${BASE}/mis-mascotas`, {
      headers: { Cookie: ownerCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    // Try to find a publicToken from pet detail links or /p/ links in HTML
    const pMatch = html.match(/\/p\/([A-Z0-9-]+)/);
    const petToken = petTokens[0];
    if (pMatch) {
      await check("anon", `/p/${pMatch[1]}`, {
        expectedStatus: 200,
        mustContain: ["main-content"],
        note: `public credential for pet ${pMatch[1]}`,
      });
    } else if (petToken) {
      // Try the first pet's token as publicToken for /p/ route
      const petDetailResp = await fetch(`${BASE}/mis-mascotas/${petToken}`, {
        headers: { Cookie: ownerCookie },
        redirect: "follow",
      });
      const petHtml = await petDetailResp.text();
      const pInDetail = petHtml.match(/\/p\/([A-Z0-9-]+)/);
      if (pInDetail) {
        await check("anon", `/p/${pInDetail[1]}`, {
          expectedStatus: 200,
          mustContain: ["main-content"],
          note: `public credential for pet ${pInDetail[1]}`,
        });
      } else {
        results.push({
          audience: "anon",
          route: "/p/<token>",
          status: 0,
          verdict: "FINDING",
          detail:
            "Could not find /p/<token> link in pet detail HTML — public credential route untested",
        });
      }
    }
  }

  // =========================================================================
  // VET routes
  // =========================================================================

  // /inicio for vet
  await check("vet", "/inicio", {
    cookie: vetCookie,
    expectedStatus: 200,
  });

  // /cuenta/upgrade — vet approved should show "Ya sos veterinario/a" state
  await check("vet", "/cuenta/upgrade", {
    cookie: vetCookie,
    expectedStatus: 200,
  });
  {
    const resp = await fetch(`${BASE}/cuenta/upgrade`, {
      headers: { Cookie: vetCookie },
      redirect: "follow",
    });
    const html = await resp.text();
    const hasApproved =
      html.includes("Ya sos veterinario/a verificado/a") ||
      html.includes("Ya sos veterinario") ||
      html.includes("veterinario/a verificado") ||
      html.includes("Matrícula verificada");
    const hasBlankRequestForm =
      (html.includes("Solicitar acceso") || html.includes("solicitar")) &&
      !html.includes("Ya sos") &&
      !html.includes("verificado/a");

    if (hasBlankRequestForm) {
      results.push({
        audience: "vet",
        route: "/cuenta/upgrade (vet state check)",
        status: 200,
        verdict: "FINDING",
        detail:
          'Vet upgrade page shows blank request form instead of approved vet state ("Ya sos veterinario/a")',
      });
    } else {
      results.push({
        audience: "vet",
        route: "/cuenta/upgrade (vet state check)",
        status: 200,
        verdict: "OK",
        detail: `Vet approved state present: ${hasApproved}`,
      });
    }
  }

  // /cuenta for vet
  await check("vet", "/cuenta", {
    cookie: vetCookie,
    expectedStatus: 200,
  });

  // =========================================================================
  // Print results
  // =========================================================================

  console.log("\n=== QA ROUTE RESULTS ===\n");

  const audiences = ["anon", "owner", "vet"];
  for (const audience of audiences) {
    const audienceResults = results.filter((r) => r.audience === audience);
    if (audienceResults.length === 0) continue;
    console.log(`--- ${audience.toUpperCase()} ---`);
    console.log(
      `${"Route".padEnd(52)} ${"Status".padEnd(8)} ${"→".padEnd(2)} ${"Verdict".padEnd(10)} Detail`,
    );
    console.log("-".repeat(130));
    for (const r of audienceResults) {
      const routeDisplay = r.route.slice(0, 51).padEnd(52);
      const statusDisplay = String(r.status).padEnd(8);
      const redirectDisplay = (r.redirectTo ?? "").slice(0, 30).padEnd(32);
      const verdictDisplay = r.verdict.padEnd(10);
      const detail = r.detail ?? "";
      console.log(
        `${routeDisplay} ${statusDisplay} ${redirectDisplay} ${verdictDisplay} ${detail}`,
      );
    }
    console.log();
  }

  const findings = results.filter((r) => r.verdict === "FINDING");
  const fiveHundreds = results.filter((r) => r.status === 500);

  console.log(`\n=== FINDINGS (${findings.length} total, ${fiveHundreds.length} HTTP 500s) ===\n`);
  if (findings.length === 0) {
    console.log("No findings — all checks passed.");
  } else {
    for (let i = 0; i < findings.length; i++) {
      const f = findings[i];
      const severity = f.status === 500 ? "HIGH" : f.verdict === "FINDING" ? "MEDIUM" : "LOW";
      console.log(
        `[F${i + 1}] [${severity}] [${f.audience.toUpperCase()}] ${f.route} (HTTP ${f.status})`,
      );
      console.log(`     ${f.detail ?? "(no detail)"}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[qa-routes] Unexpected error:", e);
  process.exit(1);
});
