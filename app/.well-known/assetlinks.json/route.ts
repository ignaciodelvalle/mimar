// GET /.well-known/assetlinks.json — the Android App Links association.
//
// The document itself and every decision about its shape live in
// lib/infra/assetlinks.ts; this file is the HTTP edge and nothing else. That
// split is not the usual thin-handler taste — it is forced, and the reason is
// worth knowing before anyone adds a second file to this directory.
//
// THIS DIRECTORY IS INVISIBLE TO MOST OF THE REPO'S TOOLING
// ---------------------------------------------------------------------------
// Its name begins with a dot, and dotted directories are skipped by default by
// nearly every glob in this repo and in the toolchain:
//
//   • TypeScript's `include` expansion skips them. MEASURED, not assumed: a
//     file planted here containing `const X: number = "no"` typechecked CLEAN
//     until `app/.well-known/**/*.ts` was added to tsconfig.json explicitly.
//   • Biome's project traversal skips them, so `biome check .` never saw it
//     either. The `lint`/`format` scripts now name the path.
//   • `node:fs` globSync does not match `**` against a dot segment, which is
//     how a route handler here would have sat outside check-authz-guards'
//     `app/**/route.ts` corpus. That fence's glob was widened in the same
//     change; the other `app/**` fences still do not see this directory.
//
// Next.js, meanwhile, routes it perfectly well — that is how `/.well-known/*`
// is served at all. Shipped code outside the checks that guard shipped code is
// the worst combination available, so the rule for this directory is: HTTP
// plumbing only, logic elsewhere.
//
// WHY A ROUTE HANDLER AND NOT A FILE IN public/
// ---------------------------------------------------------------------------
// The fingerprint is per-environment and not knowable at commit time (Play App
// Signing means the key is Google's), a static file cannot answer 404 when no
// app has been published, and it cannot tell "absent" from "misconfigured".
// The full argument is in lib/infra/assetlinks.ts.

import { MalformedFingerprintError, assetlinksDocument } from "@/lib/infra/assetlinks";
import { reportError } from "@/lib/infra/report-error";

// Read at REQUEST time, not baked into the build: rotating a fingerprint (a new
// track, a re-signed key) must not require a rebuild of the whole app.
export const dynamic = "force-dynamic";

// @no-auth-required: this document is MEANT to be fetched anonymously — by
// Android's verifier, at install time, from a device with no session and no
// prior relationship to us. Requiring anything of the caller would break the
// only mechanism it exists for. It discloses a public certificate fingerprint
// and a package name, both of which are printed in the Play listing: publishing
// them IS the association handshake, not a leak in it.
//
// (Reaching this fence at all took a widening. `app/**/route.ts` under
// `node:fs` globSync does not match a dot segment, so this handler was outside
// check-authz-guards' corpus until ROUTE_HANDLER_GLOBS gained the second
// pattern — and the fence's own count would not have moved to say so.)
export async function GET(): Promise<Response> {
  let document: ReturnType<typeof assetlinksDocument>;
  try {
    document = assetlinksDocument(process.env.ANDROID_APP_FINGERPRINT);
  } catch (err) {
    if (!(err instanceof MalformedFingerprintError)) throw err;
    // Loud, not silent. See lib/infra/assetlinks.ts: a 404 here would read as
    // "no app is associated with this host", which is a different statement
    // from "somebody configured this and got it wrong".
    reportError("well-known/assetlinks", err);
    return Response.json(
      { error: "assetlinks_misconfigured" },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  if (document === null) {
    // INTENTIONALLY ABSENT, and this is the state as of 2026-08-25: there is no
    // Play console, so there is no Play-signed fingerprint to publish, so there
    // is nothing true to say here. Android reads a 404 as "this host claims no
    // app", which is exactly correct. Set ANDROID_APP_FINGERPRINT once the app
    // is on a track and this starts serving the association with no code change.
    //
    // `no-store` because the interesting transition is 404 → 200: a CDN holding
    // the 404 would keep every install unverified for as long as the cache
    // lives, after the deploy that was supposed to fix it.
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  return Response.json(document, {
    status: 200,
    headers: {
      // The verifier is documented to require `application/json`; `Response.json`
      // sets it. One hour of caching is a compromise between the verifier's
      // fetch (which happens at install, rarely) and a fingerprint rotation
      // needing to take effect without waiting out a CDN.
      "cache-control": "public, max-age=3600",
    },
  });
}
