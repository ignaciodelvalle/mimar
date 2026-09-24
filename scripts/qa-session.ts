/**
 * QA Auth Harness — derives valid Supabase SSR cookie headers for a test user.
 *
 * Usage:
 *   pnpm exec tsx scripts/qa-session.ts <email> <password>
 *
 * Output: the Cookie header string ready to pass to fetch() or Invoke-WebRequest.
 *
 * Cookie format (from @supabase/ssr 0.5.2 source):
 *   Key:   sb-<projectRef>-auth-token
 *   Value: raw JSON session string (NOT base64 — browser client default)
 *   If encodeURIComponent(value).length > 3180 the value is split into
 *   sb-<projectRef>-auth-token.0, .1, .2, etc.
 *
 *   projectRef = hostname segment of NEXT_PUBLIC_SUPABASE_URL
 *   e.g. http://127.0.0.1:54321 → projectRef = "127"  (first label)
 *   For Supabase Cloud: https://abcxyz.supabase.co → projectRef = "abcxyz"
 *
 * Validation: the script GETs /inicio and asserts content is owner dashboard
 * (not a redirect to /login).
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { upgradeSeedSessionToAal2 } from "./lib/seed-mfa";

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

function projectRefFromUrl(url: string): string {
  // http://127.0.0.1:54321 → "127"
  // https://abcxyz.supabase.co → "abcxyz"
  try {
    const hostname = new URL(url).hostname;
    return hostname.split(".")[0];
  } catch {
    return "local";
  }
}

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];

  if (!email || !password) {
    console.error("Usage: pnpm exec tsx scripts/qa-session.ts <email> <password>");
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local",
    );
    process.exit(1);
  }

  console.error(`[qa-session] Signing in ${email} against ${supabaseUrl} ...`);

  const supabase = createClient(supabaseUrl, anonKey);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    console.error(`[qa-session] Sign-in failed: ${error?.message ?? "no session returned"}`);
    process.exit(1);
  }

  // Institutional accounts owe TOTP since T2-S6: bring the session to aal2
  // (no-op for personal accounts). scripts/lib/seed-mfa.ts.
  await upgradeSeedSessionToAal2(supabase, email, password);
  const session = (await supabase.auth.getSession()).data.session ?? data.session;
  const projectRef = projectRefFromUrl(supabaseUrl);
  const cookieKey = `sb-${projectRef}-auth-token`;

  // @supabase/ssr reads the session JSON from the cookie directly (no base64 encoding
  // in browser-client mode). The value stored is the full session object as JSON.
  const sessionJson = JSON.stringify(session);

  const cookiePairs = createChunks(cookieKey, sessionJson);

  const cookieHeader = cookiePairs.map(({ name, value }) => `${name}=${value}`).join("; ");

  // Validate: GET /inicio must return owner content (not /login redirect)
  console.error("[qa-session] Validating cookie against http://localhost:3000/inicio ...");
  const response = await fetch("http://localhost:3000/inicio", {
    headers: { Cookie: cookieHeader },
    redirect: "manual",
  });

  const status = response.status;
  const location = response.headers.get("location") ?? "";
  const body = status < 400 ? await response.text() : "";

  const isRedirectToLogin = status >= 300 && status < 400 && location.includes("/login");
  const hasOwnerContent =
    body.includes("Mis mascotas") ||
    body.includes("Buen d") ||
    body.includes("Próximos turnos") ||
    body.includes("Vencimientos") ||
    body.includes("Asentar un hecho");

  if (isRedirectToLogin) {
    console.error(
      `[qa-session] VALIDATION FAILED — /inicio redirected to ${location} (cookie not accepted)`,
    );
    console.error(`[qa-session] Cookie was: ${cookieHeader.slice(0, 120)}...`);
    process.exit(1);
  }

  if (status !== 200) {
    console.error(`[qa-session] VALIDATION WARNING — /inicio returned HTTP ${status}`);
  }

  if (!hasOwnerContent) {
    console.error(
      "[qa-session] VALIDATION WARNING — /inicio returned 200 but expected owner content markers not found",
    );
    console.error(`[qa-session] Body snippet: ${body.slice(0, 400)}`);
  } else {
    console.error(`[qa-session] Validation OK — /inicio returned ${status} with owner content`);
  }

  // Print cookie to stdout for piping
  console.log(cookieHeader);
}

main().catch((e) => {
  console.error("[qa-session] Unexpected error:", e);
  process.exit(1);
});
