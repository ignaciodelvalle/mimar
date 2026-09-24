// QA session minting — produce ready-to-set auth cookies for the synthetic
// demo accounts, so a browser-driving QA agent can switch accounts without
// typing passwords or touching any auth-bypass surface in the product.
//
// WHY THIS EXISTS (and why there is deliberately NO dev-login endpoint):
// dim-staging is a public, funcionario-facing environment. An auth-bypass
// route gated "by env" is one misconfigured deploy away from being real
// (see engram ops/staging-analytics-db-password for how long a bad staging
// env var can survive unnoticed). This script instead performs a NORMAL
// password login against Supabase auth — outside the app, with the same
// @supabase/ssr library the app uses — and prints the exact cookies the app
// expects. No product code path changes; no secrets are required: the URL
// and anon key are public by design, and the shared seed password is already
// committed in this public repo (scripts/seed-demo.ts).
//
// Usage:
//   QA_SUPABASE_URL=https://<ref>.supabase.co QA_SUPABASE_ANON_KEY=<anon> \
//     pnpm exec tsx scripts/qa-mint-sessions.ts [comma-separated-emails] [--json out.json]
//
// Defaults to the 7 demo-narrative accounts. Output: per account, the cookie
// list (name/value) to set for the app origin via CDP Network.setCookie
// (domain: the app host, path: /, secure: true, sameSite: Lax). Switching
// accounts = delete existing sb-* cookies for the origin, set the new pair,
// reload. Sessions carry refresh tokens, so they outlive the 1h access token.

import { writeFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

const DEFAULT_EMAILS = [
  "owner@dim.test",
  "alejo@dim.test",
  "noeli@dim.test",
  "lilian@dim.test",
  "graciela@dim.test",
  "lucas@dim.test",
  "admin@dim.test",
];

const url = process.env.QA_SUPABASE_URL;
const anonKey = process.env.QA_SUPABASE_ANON_KEY;
const password = process.env.QA_SHARED_PASSWORD ?? "Test1234!";

if (!url || !anonKey) {
  console.error("QA_SUPABASE_URL and QA_SUPABASE_ANON_KEY are required.");
  process.exit(1);
}

const args = process.argv.slice(2);
const jsonFlagIndex = args.indexOf("--json");
const jsonOutPath = jsonFlagIndex >= 0 ? args[jsonFlagIndex + 1] : null;
const emailsArg = args.find((a, i) => !a.startsWith("--") && i !== jsonFlagIndex + 1);
const emails = emailsArg ? emailsArg.split(",").map((e) => e.trim()) : DEFAULT_EMAILS;

interface MintedAccount {
  email: string;
  cookies: { name: string; value: string }[];
  error?: string;
}

async function mint(email: string): Promise<MintedAccount> {
  // In-memory cookie jar: createServerClient writes the session through
  // setAll exactly as it would into Next's response cookies — same names,
  // same base64 encoding, same chunking. We just capture instead of send.
  const jar = new Map<string, string>();
  const supabase = createServerClient(url as string, anonKey as string, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (cookies: { name: string; value: string }[]) => {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { email, cookies: [], error: error.message };
  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, email, password);
  return { email, cookies: [...jar.entries()].map(([name, value]) => ({ name, value })) };
}

const results: MintedAccount[] = [];
for (const email of emails) {
  // Sequential on purpose: distinct emails dodge the per-email limit anyway,
  // but a serial trickle also stays far from any per-IP auth burst limit.
  results.push(await mint(email));
  const last = results[results.length - 1];
  console.log(
    last.error
      ? `✗ ${last.email}: ${last.error}`
      : `✓ ${last.email}: ${last.cookies.length} cookie(s), ${last.cookies.reduce((n, c) => n + c.value.length, 0)} bytes`,
  );
}

if (jsonOutPath) {
  writeFileSync(
    jsonOutPath,
    JSON.stringify({ mintedAt: new Date().toISOString(), results }, null, 2),
  );
  console.log(`\nWrote ${jsonOutPath}`);
} else {
  console.log(JSON.stringify(results, null, 2));
}

const failed = results.filter((r) => r.error).length;
process.exit(failed > 0 ? 1 : 0);
