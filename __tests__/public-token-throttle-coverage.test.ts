// Every anonymous route that resolves a public credential token must apply the
// per-IP read limit.
//
// WHY A COVERAGE FENCE AND NOT A BEHAVIOURAL TEST. The defect was never that
// the limiter did the wrong thing — it works, and /p/[publicToken] has used it
// since V1-1. The defect was that two sibling routes resolving the SAME token
// through the SAME `publicPetByToken()` lookup simply never called it, under a
// comment in the third file asserting the guard ran "before touching any pet
// data". Testing the limiter's behaviour again would have kept passing while
// the gap existed; only enumerating the ROUTES can catch a route that forgot.
//
// It matters most for /encontre, whose "allowFinderFormWhenLost=false" branch
// renders the owner's tel:/mailto: and calls the Supabase ADMIN API to resolve
// their email — an unauthenticated path to a privileged lookup.
//
// WHAT THIS FENCE ENUMERATED, AND WHAT IT SHOULD HAVE (fixed 2026-08-21)
// ---------------------------------------------------------------------------
// It walked `page.tsx` files under one directory. The SUBJECT is "anonymous
// code that resolves a public credential token", and the two are not the same
// set: `opengraph-image.tsx` is a separate HTTP route by Next file convention
// — WhatsApp, Facebook and Google fetch it directly, not as part of the page
// render — and it is not called page.tsx, so this fence could not see it. It
// sat unthrottled and unbudgeted, answering "is this animal lost?" through its
// own artwork (SE BUSCA vs Credencial pública) on the most expensive read in
// the product: a 1200x630 satori render per hit.
//
// So the enumeration derives from CALL SITES of `publicPetByToken`, which is
// the thing the rule is actually about. Anything that resolves a public token
// is in scope by construction, whatever the file is called and wherever it
// lives. The exemptions below are the shapes that legitimately do not take the
// READ limiter, each with the reason and the limiter it takes instead.
//
// THE SAME PREDICATE HAS A SECOND NAME this census deliberately does not
// match: `unerasedPetByToken`, the authenticated alias. Which files may spell
// it is pinned by the ALIAS census at the bottom of this file — added
// 2026-08-28, when the blind spot ("an anonymous route resolving through the
// alias escapes this enumeration") turned out to have no fence at all.
//
// WIDENED TO src/ (Track 2, 2026-08-21) — AND WHY, IN THE SAME COMMIT
// ---------------------------------------------------------------------------
// The scan walked `app/` only. That was the whole world while every resolver
// was a route file, and it stopped being true the moment the credential's
// decision moved into a use-case: `lookupPublicCredential` in
// src/modules/pets/application/read/ now runs the throttle, the pet-row lookup
// and the view-data fan-out, and the page is a renderer over its four-way
// answer. An `app/`-only walk would have watched the guard leave its scope and
// reported nothing — the fence would have gone green precisely because the
// code it guards moved. So the roots widened in the commit that moved it.
//
// The move also changed what "applies the guard" LOOKS like, and the fence has
// to accept the new shape without accepting less:
//
//   • DIRECT  — `await isPublicTokenReadThrottled("bucket")` in the route
//     itself. The original shape; still how /encontre, /sighting and the OG
//     image do it.
//   • PORT    — `await throttle.isThrottled()` inside a use-case. The use-case
//     may NOT import next/headers (the application fence), so the limiter
//     arrives as a parameter. It is REQUIRED, so no caller can reach the pet
//     row without one: the type checker enforces what this fence merely
//     watches.
//   • WRITE   — `await enforceRateLimit("<surface>:<token>", ip, …)` in an
//     anonymous POST use-case. A harder limit than the read one (1/min + 10/hr
//     per IP+token vs 60/min), so it bounds the same enumeration more tightly;
//     what it does NOT do on its own is bound it FIRST. See below.
//   • ADAPTER — `publicTokenThrottle("bucket")` at a call site that hands the
//     port to such a use-case. The file does not run the guard; it supplies it.
//
// EVERY FORM IS ALSO AN ORDERING (widened 2026-08-21)
// ---------------------------------------------------------------------------
// The WRITE form arrived by DELETING two exemptions, not by adding a loophole.
// report-pet-sighting.ts and report-dispute-tip.ts were exempt on the written
// ground that their write limiter "runs before it resolves the token" — and it
// ran after, in both. Nothing checked, because the ordering rule was stated for
// the `port` shape only. A hand-rolled POST needs no page load, so each was an
// unbounded oracle answering "does this token exist?" and "is this animal lost
// / under custody review?" through its DISTINCT refusal strings. The order was
// inverted in the same commit, the exemptions deleted, and the ordering check
// generalised to whichever form a file carries.
//
// EVERY PREDICATE READS CODE, NOT COMMENTS (fixed 2026-08-21)
// ---------------------------------------------------------------------------
// The match texts are sentence fragments. A docblock stating the contract
// truthfully contains them verbatim, so the fence used to grade documentation:
// a use-case with `// …run: await throttle.isThrottled()` and no limiter passed
// as `port`, and a comment warning against `publicTokenThrottle(someVariable)`
// failed the literal-bucket check. Everything below goes through
// scripts/lib/strip-comments.mjs first.
//
// The ADAPTER form is the one that could rot into a hole, so it carries a
// second layer: every caller of `lookupPublicCredential(` must pass
// `throttle: publicTokenThrottle("<literal>")` naming a bucket from the known
// list. A non-literal bucket is rejected — `publicTokenThrottle(bucket)` with a
// variable is how one surface silently starts spending another's counter, and
// makes "which surface is being hammered" unanswerable from the storage.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "@/scripts/lib/strip-comments.mjs";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
/** Both layers that can resolve a public token: route files and use-cases. */
const SCAN_ROOTS = ["app", "src"] as const;
const GUARD = "isPublicTokenReadThrottled";
const LOOKUP = "publicPetByToken(";
/** The application-layer door every public-credential renderer goes through. */
const DOOR = "lookupPublicCredential(";
/** The file that DEFINES the door — the one src/ resolver the RED controls read. */
const DOOR_FILE = "src/modules/pets/application/read/lookup-public-credential.ts";
/** The infrastructure adapter that binds the limiter to a request. */
const ADAPTER = "publicTokenThrottle(";
/** How a use-case applies the injected limiter. */
const PORT_CALL = "await throttle.isThrottled()";
/** The harder per-(IP, token) limiter the anonymous WRITE use-cases take. */
const WRITE_LIMITER = "await enforceRateLimit(";

/**
 * Every limiter bucket this surface family is allowed to spend. A bucket per
 * route so one abusive scraper cannot spend a legitimate finder's budget on a
 * different page, and so the counters stay readable when someone asks which
 * surface is being hammered.
 *
 * `public_token_api_credential` was listed here BEFORE its route existed, so
 * that adding the endpoint would not also be a fence edit under time pressure.
 * It landed on 2026-08-21 (`app/api/v1/pets/[publicToken]/credential/route.ts`)
 * and the reservation is now a real user — which the door-caller assertions
 * below exercise, so nothing has to remember to delete this note.
 *
 * The endpoint's SECOND bucket, `public_token_api_credential_lookup`, is NOT
 * in this set: this set gates the adapter's first argument, the per-IP surface
 * bucket. The narrower per-(token, IP) limiter has its own set below.
 */
const KNOWN_BUCKETS = new Set([
  "public_token_page",
  "public_token_sighting",
  "public_token_og_image",
  "public_token_encontre",
  // The FIFTH HTML surface, added 2026-08-25. It was exempt on a disclosure
  // argument that was true and incomplete — see the note above EXEMPT.
  "public_token_adoptar",
  "public_token_api_credential",
]);

/**
 * Every legitimate PER-LOOKUP bucket — the narrower limiter a route may layer
 * inside the adapter's options (`{ perLookup: { bucket, key, limit } }`).
 *
 * ADDED 2026-08-22 (G4). Until then this file read only the adapter's first
 * argument, and the header above said the per-lookup bucket "is not a
 * call-site literal this predicate could read anyway" — so the first endpoint
 * shipped `bucket: LOOKUP_BUCKET`, a module constant, in the one position the
 * fence was not looking at. The rule is the same for both positions and for
 * the same reason: a computed bucket is how one surface starts spending
 * another's counter. The route writes the literal; `limits.ts` keeps the
 * constant for the tests, which pin the two to each other.
 */
const KNOWN_LOOKUP_BUCKETS = new Set(["public_token_api_credential_lookup"]);

/**
 * The ONE place two resolvers may name the same bucket — each entry says which
 * file, exactly which buckets, and why sharing them is the point rather than a
 * collision.
 *
 * ADDED 2026-09-23 (third pass of the /p/{token} 404 fix, after the re-review).
 * The landing layout's probe charges the bucket of the route actually rendering,
 * and the sibling page's own direct guard then reads that SAME memoised charge.
 * The first version computed the bucket from a map, so `bucketLiterals` could
 * not see it and "gives each route its own limiter bucket" skipped the file in
 * silence — the rule held only because nobody had tested it against this file.
 * Written as literals, the probe's names collide with the pages' on purpose,
 * and the collision is declared here instead of hidden from the census.
 *
 * `public_token_page` is NOT listed: /p/{token}/page.tsx reaches it through the
 * door's adapter and is not itself a resolver, so the probe is the only
 * resolver naming it.
 */
const SHARED_BUCKETS: Record<string, { buckets: readonly string[]; reason: string }> = {
  "app/(public)/p/[publicToken]/credential-probe.ts": {
    buckets: ["public_token_encontre", "public_token_sighting"],
    reason:
      "The layout's 404 probe charges the bucket of the sibling route being rendered, and that route's own isPublicTokenReadThrottled call reads the SAME React.cache-memoised charge — one visit, one charge, on the route's own counter. Sharing the name IS the design: a separate probe bucket would bill every /encontre and /sighting visit twice.",
  },
};

type Source = { file: string; src: string };

/**
 * Resolvers that legitimately do NOT take the read limiter. Each names the
 * reason and what bounds it instead — an exemption without a stated
 * alternative is just a hole with a comment.
 *
 * THREE CAME OUT ON 2026-08-21, AND THE REASON IS WHY THIS LIST IS DANGEROUS.
 * `report-pet-sighting.ts` and `report-dispute-tip.ts` were exempt on the
 * written ground that their harder write limiter "runs before it resolves the
 * token". It did not — both resolved the token FIRST and consulted the limiter
 * afterwards, so each was an unbounded token-existence-and-status oracle for
 * any hand-rolled POST. The exemption text asserted an ORDER that nothing
 * checked, which is strictly worse than no exemption: it reads as a reviewed
 * decision. The fix inverted the real order and both files are now IN SCOPE,
 * carrying the WRITE form below where the fence can see the ordering itself.
 *
 * `encontre/action.ts` was the THIRD, and its exemption is the reason to
 * distrust the honest-looking ones too. When the first two were fixed, this
 * file's entry was REWRITTEN to admit the same inversion — "its limiter runs
 * AFTER its token lookup … Tracked, not fixed here" — and left in place. A
 * documented hole is still a hole, and the file it excused is the heaviest of
 * the three: its refusals distinguish "no existe" from "no está perdida" from
 * "titularidad en revisión", and its non-form branch calls the Supabase ADMIN
 * API to resolve the owner's email. The order was inverted and the entry
 * deleted in the same commit, so the WRITE form's positional check below now
 * covers it like the other two.
 */
const EXEMPT: Record<string, string> = {
  "app/(public)/adoptar/[petToken]/postular/page.tsx":
    "The APPLY step, reached from the detail page — which is no longer exempt (2026-08-25) and carries `public_token_adoptar` before its own lookup. A caller who reaches this page has already spent a request against that bucket to find it, and the two share nothing else: this one renders a form and no pet identity beyond the name already on the card. Its own bucket would bill the same visit twice for a surface that adds no oracle the detail page has not already answered. CLOSED BY: nothing pending — this is the exemption, not a debt.",
};

/**
 * THE DETAIL PAGE CAME OUT ON 2026-08-25, and its old entry is worth quoting
 * because it is the shape of a plausible exemption that was half an argument.
 *
 * It read: "Resolves only pets that are adoption-LISTED — a non-listed token
 * reaches notFound() at the isListable gate. Listed pets are already enumerable
 * from the public /adoptar catalog, so this surface reveals nothing the catalog
 * does not."
 *
 * Every sentence of that is TRUE, and all of it is about DISCLOSURE. A limiter
 * on this surface is for two other things as well, and the exemption did not
 * mention either: the page is still a per-token existence-and-listed oracle over
 * a 31^8 space (the catalog answers "which pets are listed", never "is
 * DIM-XXXX-XXXX one of them"), and it is still unbounded WORK on a
 * `force-dynamic` route — two joined queries, an ownership lookup and a
 * sponsorship read, for anyone who cares to ask, at any rate.
 *
 * The framing that called the throttled set "the four HTML surfaces" is what let
 * that stand: a fifth surface of the same shape reads as an exception when the
 * count is in the prose. It is five now, here and in
 * lib/infra/public-token-throttle.ts.
 */

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * The file's CODE, with every comment blanked to whitespace.
 *
 * WHY EVERY PREDICATE GOES THROUGH THIS. The match texts below are sentence
 * fragments — `await throttle.isThrottled()`, `publicTokenThrottle(` — and a
 * docblock that TELLS THE TRUTH about the contract contains them verbatim. So
 * the fence reacted to documentation, in both directions:
 *
 *   - Fails OPEN: a use-case with `// The caller is expected to have run:
 *     await throttle.isThrottled()` in a comment and NO limiter in code read as
 *     `port`, ordering check included.
 *   - Fails CLOSED: a Track 2 writer's accurate comment explaining why a
 *     variable bucket is banned — it named `publicTokenThrottle(someVariable)`
 *     — was tallied as a real call site and failed the literal-bucket check. A
 *     fence that penalises correct documentation teaches worse comments.
 *
 * scripts/lib/strip-comments.mjs substitutes whitespace 1:1 and keeps newlines,
 * so byte offsets survive and the ORDERING comparisons below still line up with
 * the original file. Memoised because the resolver filter strips every file
 * under both roots (~1400 files, ~60ms) and the predicates then re-ask for the
 * same handful.
 *
 * STATED BLIND SPOT: `stripComments` keeps string contents, so a guard name
 * inside a string literal still classifies — zero occurrences in the tree today,
 * and the same trade scripts/check-authz-guards.ts documents (removing string
 * bodies would blind the fences that read emitted markup out of literals).
 */
const strippedCache = new Map<string, string>();
function code(src: string): string {
  const hit = strippedCache.get(src);
  if (hit !== undefined) return hit;
  const out = stripComments(src);
  strippedCache.set(src, out);
  return out;
}

/**
 * Every non-test source file under the scanned roots, with its contents.
 *
 * MEMOISED, per call, for the whole file (2026-09-02). Every predicate below
 * starts from this walk and each test re-asks for it — ~1400 files read from
 * disk, a dozen times over. Run 1 of `pnpm test:verified` in gate 0901f timed
 * out at the 5000 ms default here, immediately after `pnpm verify`'s Next build
 * had just written `.next` and left the page cache cold; run 2 over the same
 * tree took 3915 ms. The 30 s ceiling below bought room; this removes the cost.
 *
 * The cache is safe because the tree does NOT change during a run — the repo
 * forbids editing files while a gate is in flight for exactly the reason that
 * would break it — and because `code()` already memoises the stripped form of
 * the same contents, so the two caches now have the same lifetime. Nothing here
 * mutates a `Source`; the RED controls all build their own inline fixtures and
 * never touch this list.
 */
let sourcesCache: Source[] | null = null;
function allSources(): Source[] {
  if (sourcesCache !== null) return sourcesCache;
  const found: Source[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      const file = join(entry.parentPath, entry.name);
      found.push({
        file: file.slice(ROOT.length + 1).replaceAll("\\", "/"),
        src: readFileSync(file, "utf8"),
      });
    }
  }
  sourcesCache = found.sort((a, b) => a.file.localeCompare(b.file));
  return sourcesCache;
}

/** Every file that resolves a public credential token — in CODE, not in prose. */
function publicTokenResolvers(): Source[] {
  return allSources().filter((s) => code(s.src).includes(LOOKUP));
}

/** The ones the rule applies to: resolvers minus documented exemptions. */
function publicTokenPages(): Source[] {
  return publicTokenResolvers().filter((s) => EXEMPT[s.file] === undefined);
}

// ---------------------------------------------------------------------------
// Pure predicates — the fence logic, testable against fixtures (RED controls)
// ---------------------------------------------------------------------------

/**
 * The four legitimate shapes, each mapped to the call text that proves it RAN.
 *
 * Matching the awaited CALL and not the identifier is deliberate: a bare
 * `includes(GUARD)` is satisfied by the import line alone, so deleting the
 * guard from a page's body would leave this green. Caught by mutating one page.
 *
 * Probe order matters — a file carrying two shapes is classified by the
 * strongest one it runs itself, and `adapter` (which runs nothing, it only
 * SUPPLIES a limiter) is last.
 */
const FORM_CALLS = {
  direct: `await ${GUARD}(`,
  port: PORT_CALL,
  write: WRITE_LIMITER,
  adapter: ADAPTER,
} as const;
type GuardForm = keyof typeof FORM_CALLS;
const FORM_PROBE_ORDER: readonly GuardForm[] = ["direct", "port", "write", "adapter"];

/**
 * The forms that can ANCHOR an ordering — i.e. the ones that actually consult a
 * limiter. `adapter` is deliberately absent.
 *
 * NARROWED 2026-08-21. `guardPrecedesLookup` compared the lookup against every
 * value in FORM_CALLS, `publicTokenThrottle(` included — and that call BUILDS a
 * limiter, it asks it nothing. Nothing is consulted until someone awaits
 * `isThrottled()`, which happens inside the door, in another file. So a block
 * that constructed the limiter and then resolved the token ITSELF, never passing
 * it anywhere, certified as "guard before lookup" — the exact inversion the
 * check exists to catch, wearing the syntax of compliance.
 *
 * The adapter stays a legitimate CLASSIFICATION (a page that only hands the port
 * to the door runs no limiter of its own and is not an offender); it is just not
 * evidence of an order. A file that supplies the port AND resolves a token by
 * itself has to show one of the three real forms for its own lookup.
 */
const ORDERING_ANCHORS: readonly string[] = [FORM_CALLS.direct, FORM_CALLS.port, FORM_CALLS.write];

/** Which of the four legitimate forms a file carries, or null. */
function guardForm(src: string): GuardForm | null {
  const c = code(src);
  return FORM_PROBE_ORDER.find((form) => c.includes(FORM_CALLS[form])) ?? null;
}

/**
 * The BUCKET argument handed to each adapter call, e.g. `"public_token_page"`.
 *
 * WIDENED 2026-08-21, AND THE WIDENING IS THE HONEST KIND. It used to be
 * `publicTokenThrottle\(([^)]*)\)` — everything up to the first `)` — which
 * assumed a one-argument call. The adapter now takes an optional second
 * argument (`{ perLookup: … }`, the narrower limiter the /api/v1 route layers
 * on top), so that pattern captured `"public_token_api_credential", {` and
 * failed the literal check on a call that is perfectly literal.
 *
 * The fix reads only the FIRST argument — up to a comma or the closing paren —
 * because the first argument is what the rule is about: one surface, one named
 * bucket, no computed value. It is NOT a relaxation: a variable first argument
 * still fails (see the RED controls below, including one for the two-argument
 * shape specifically). What the fence stops watching is the second argument,
 * which names its own bucket inside an object and is not a call-site literal
 * this predicate could read anyway.
 */
function adapterArgs(src: string): string[] {
  const out: string[] = [];
  const re = /publicTokenThrottle\(\s*([^,)]*)/g;
  const c = code(src);
  for (let m = re.exec(c); m !== null; m = re.exec(c)) out.push(m[1].trim());
  return out;
}

/**
 * The `bucket:` value inside every `perLookup: { … }` object a file passes to
 * the adapter (G4). Read separately from `adapterArgs` because it is not the
 * first argument — it is a property of the second — and the 2026-08-21
 * widening deliberately stopped reading past the first comma.
 */
function perLookupBucketArgs(src: string): string[] {
  const out: string[] = [];
  const re = /perLookup\s*:\s*\{([^}]*)\}/g;
  const c = code(src);
  for (let m = re.exec(c); m !== null; m = re.exec(c)) {
    const bucket = m[1].match(/\bbucket\s*:\s*([^,}]*)/);
    if (bucket) out.push(bucket[1].trim());
  }
  return out;
}

/**
 * Every bucket literal a file names, in either the direct or adapter form.
 *
 * Same widening as `adapterArgs`, for the same reason: the trailing `\)` in the
 * old pattern silently stopped matching the moment the adapter grew a second
 * argument, and a bucket-uniqueness check that matches NOTHING passes.
 */
function bucketLiterals(src: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:${GUARD}|publicTokenThrottle)\\(\\s*"([^"]+)"`, "g");
  const c = code(src);
  for (let m = re.exec(c); m !== null; m = re.exec(c)) out.push(m[1]);
  return out;
}

/** True for the file that DEFINES the door (it takes the port, never binds it). */
function definesDoor(src: string): boolean {
  return code(src).includes(`export async function ${DOOR.slice(0, -1)}(`);
}

/**
 * Problems with one caller of the door: it must hand over a limiter, and the
 * bucket must be a literal from the known list.
 */
function doorCallerViolations({ file, src }: Source): string[] {
  const problems: string[] = [];
  if (!code(src).includes(`throttle: ${ADAPTER}`)) {
    problems.push(`${file}: calls ${DOOR} without \`throttle: ${ADAPTER}…)\``);
  }
  for (const arg of adapterArgs(src)) {
    if (!/^"[a-z_]+"$/.test(arg)) {
      problems.push(`${file}: limiter bucket must be a string literal, got \`${arg}\``);
    } else if (!KNOWN_BUCKETS.has(arg.slice(1, -1))) {
      problems.push(`${file}: unknown limiter bucket ${arg}`);
    }
  }
  // G4: the narrower limiter's bucket is held to the same rule.
  for (const arg of perLookupBucketArgs(src)) {
    if (!/^"[a-z_]+"$/.test(arg)) {
      problems.push(`${file}: per-lookup bucket must be a string literal, got \`${arg}\``);
    } else if (!KNOWN_LOOKUP_BUCKETS.has(arg.slice(1, -1))) {
      problems.push(`${file}: unknown per-lookup bucket ${arg}`);
    }
  }
  return problems;
}

/**
 * The forms a RESOLVER may carry: the three that run a limiter in the file.
 *
 * NARROWED 2026-09-23 (re-review of the /p/{token} 404 fix). `adapter` only
 * SUPPLIES a limiter to the door; a file whose only form is the adapter and
 * which also resolves a token by itself has shown no guard for its OWN lookup.
 * The adapter stays enforced where it belongs — on the door's callers, by
 * `doorCallerViolations` — and is no longer accepted from a resolver.
 */
const RESOLVER_FORMS: readonly GuardForm[] = ["direct", "port", "write"];

/** A resolver whose guard form is missing or is not one a resolver may use. */
function resolverFormViolations({ file, src }: Source): string[] {
  const form = guardForm(src);
  if (form === null) return [`${file}: resolves a token and runs no limiter`];
  if (!RESOLVER_FORMS.includes(form)) {
    return [`${file}: resolves a token but its only guard form is \`${form}\``];
  }
  return [];
}

/**
 * The first argument of every DIRECT-form guard call a file makes.
 *
 * ADDED 2026-09-23. `bucketLiterals` reads only string literals, so a direct
 * guard called with a computed bucket (`isPublicTokenReadThrottled(MAP[k])`)
 * was invisible to the one-bucket-per-route census — the credential probe
 * shipped exactly that shape. Same rule as the adapter's first argument: one
 * named surface, no computed value.
 */
function directGuardArgs(src: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`await ${GUARD}\\(\\s*([^,)]*)`, "g");
  const c = code(src);
  for (let m = re.exec(c); m !== null; m = re.exec(c)) out.push(m[1].trim());
  return out;
}

/** A direct-form guard must name a literal, known bucket. */
function directGuardViolations({ file, src }: Source): string[] {
  const problems: string[] = [];
  for (const arg of directGuardArgs(src)) {
    if (!/^"[a-z_]+"$/.test(arg)) {
      problems.push(`${file}: direct guard bucket must be a string literal, got \`${arg}\``);
    } else if (!KNOWN_BUCKETS.has(arg.slice(1, -1))) {
      problems.push(`${file}: unknown direct guard bucket ${arg}`);
    }
  }
  return problems;
}

/**
 * Buckets named by more than one resolver, minus the declared allowances.
 *
 * An allowance only covers ITS file and ITS buckets, and only while the bucket
 * really is shared with exactly one other resolver — a declared share that no
 * longer collides, or that now collides with two files, is itself reported.
 */
function bucketCollisions(
  sources: readonly Source[],
  allowances: Record<string, { buckets: readonly string[] }>,
): string[] {
  const owners = new Map<string, string[]>();
  for (const { file, src } of sources) {
    for (const bucket of bucketLiterals(src)) {
      owners.set(bucket, [...(owners.get(bucket) ?? []), file]);
    }
  }
  const problems: string[] = [];
  for (const [bucket, files] of owners) {
    const allowed = files.filter((f) => allowances[f]?.buckets.includes(bucket));
    const counted = files.filter((f) => !allowances[f]?.buckets.includes(bucket));
    if (counted.length > 1) problems.push(`${bucket} is named by ${counted.join(", ")}`);
    if (allowed.length > 0 && counted.length !== 1) {
      problems.push(
        `${bucket}: declared as shared by ${allowed.join(", ")}, but ${counted.length} other resolver(s) name it`,
      );
    }
  }
  for (const [file, { buckets }] of Object.entries(allowances)) {
    for (const bucket of buckets) {
      if (!(owners.get(bucket) ?? []).includes(file)) {
        problems.push(`${file}: declares ${bucket} as shared but does not name it`);
      }
    }
  }
  return problems;
}

/**
 * The ways a resolver reaches the pet row: the query helper, the injected port,
 * or the door file's own unexported resolver.
 *
 * `findPetByPublicToken(` JOINED 2026-08-21, AND IT WAS A REAL HOLE IN THE ONE
 * FILE THIS FENCE NAMES BY PATH. `lookup-public-credential.ts` reaches the pet
 * row through that unexported helper; a SIBLING export calling it resolves the
 * token just as completely, and matched NEITHER marker — `findPetByPublicToken(`
 * does not contain `publicPetByToken(` (the capital P is the whole difference)
 * and is not `.findPet(` either. Its block therefore held no lookup at all, and
 * `guardPrecedesLookup` has nothing to say about a block that never resolves
 * anything. A marker list is an enumeration of NAMES, so it carries the standing
 * risk this repo keeps paying for: the next private resolver gets a new name and
 * is invisible until someone adds it here. What bounds that risk is scope — the
 * helper is unexported, so only this file can call it, and this file is fenced.
 */
const LOOKUP_MARKERS = [LOOKUP, ".findPet(", "findPetByPublicToken("] as const;

/**
 * Where a top-level export begins — ANY top-level `export`, whatever follows it.
 *
 * WIDENED 2026-08-21, FROM A SHAPE LIST TO THE KEYWORD. It used to enumerate the
 * export forms it knew (`export async function`, `export default async function`,
 * `export const NAME = async …`), which made every OTHER spelling a non-boundary
 * — and a non-boundary body is read as a continuation of the export above it and
 * INHERITS that export's guard. `export default async (req) => …` is how route
 * handlers are written, and `export function` is one keyword away from any of
 * them. Banning the spellings you thought of is the failure this repo has a name
 * for; the boundary is the `export` keyword, which is the subject.
 *
 * `export type` / `export interface` / `export {` are boundaries too. They are
 * harmless: an extra boundary only ever SPLITS a block, and splitting is
 * monotonically stricter — a lookup can lose an earlier block's guard, never
 * gain one. The same argument covers the two ways this line-anchored match can
 * fire on something that is not a top-level export: an indented `export` inside
 * a `declare module`, and — since `stripComments` keeps string CONTENTS — a
 * string literal holding the word `export` at the start of a line. Both split a
 * block that should have stayed whole, so both fail CLOSED: noisy, never blind.
 *
 * Leading whitespace is tolerated on purpose — the RED-control fixtures below
 * are indented template literals, and a boundary rule that only fires at column
 * zero would silently degrade every one of them to a single block, which is the
 * exact whole-file behaviour these controls exist to catch. (That is also why
 * `extractExportedAsyncFunctions` from scripts/check-authz-guards.ts is not
 * reused here: it anchors at column zero, it does not know the `export const …
 * = async` shape, and it drops unexported helpers entirely — the third one
 * matters, because the real tree's only unexported resolver is exactly such a
 * helper.)
 */
const EXPORT_BOUNDARY_RE = /^[ \t]*export\b/gm;

/**
 * The stripped source cut into one block per top-level export.
 *
 * A block runs from its export boundary to the next one (or EOF), so anything
 * declared between two exports — an unexported helper, a module constant —
 * belongs to the export ABOVE it. That attribution is deliberate and it is the
 * conservative one: `lookup-public-credential.ts` resolves the token inside
 * `findPetByPublicToken`, an unexported helper declared BELOW the guarded door,
 * and the block model reads that as covered (it is: nothing else calls it, and
 * the door ran its limiter first). A helper declared ABOVE every export belongs
 * to no guarded function and is flagged — see the RED control for it.
 */
function exportBlocks(c: string): string[] {
  const starts: number[] = [];
  const re = new RegExp(EXPORT_BOUNDARY_RE.source, "gm");
  for (let m = re.exec(c); m !== null; m = re.exec(c)) starts.push(m.index);
  if (starts.length === 0) return [c];
  const blocks = starts[0] > 0 ? [c.slice(0, starts[0])] : [];
  for (let i = 0; i < starts.length; i++) {
    blocks.push(c.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : c.length));
  }
  return blocks;
}

/** First position at which any of `needles` appears, or -1. */
function firstIndexOf(block: string, needles: readonly string[]): number {
  let best = -1;
  for (const needle of needles) {
    const at = block.indexOf(needle);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  }
  return best;
}

/**
 * True when EVERY function that resolves a token ran a guard first — in its OWN
 * body, not somewhere else in the file.
 *
 * Generalised from a port-only check on 2026-08-21, when the two anonymous
 * WRITE use-cases came out of EXEMPT: their limiter is `enforceRateLimit`, and
 * a rule stated only for the `port` shape would have watched them enter scope
 * and said nothing about the very ordering that made them oracles.
 *
 * MADE PER-FUNCTION THE SAME DAY, AND THIS ONE WAS A REAL HOLE. It compared the
 * FIRST guard call in the file against the FIRST lookup in the file — two
 * offsets, whole-file — so a module whose opening function is guarded vouched
 * for every function below it. A second entry point added next to the first,
 * with no limiter, passed. That is not a hypothetical shape: it is what these
 * files look like the day someone adds a sibling use-case, which is exactly
 * when nobody re-reads the ordering. Each export block is now judged on its own
 * body, and a block that reaches the pet row without a guard above it fails
 * whatever its neighbours do.
 */
function guardPrecedesLookup(src: string): boolean {
  // A file carrying no legitimate form at all is out of order by definition —
  // and this is what keeps a guard that lives only in a comment from counting.
  if (guardForm(src) === null) return false;
  for (const block of exportBlocks(code(src))) {
    const lookupAt = firstIndexOf(block, LOOKUP_MARKERS);
    if (lookupAt === -1) continue;
    const guardAt = firstIndexOf(block, ORDERING_ANCHORS);
    if (guardAt === -1 || guardAt > lookupAt) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The fence, over the real tree
// ---------------------------------------------------------------------------

// This suite reads app/ + src/ off disk once and reuses it (allSources() is
// memoised above; that WAS the "separate, later follow-up" this comment used to
// promise, landed 2026-09-02). The ceiling stays where it is: the FIRST call
// still pays the full recursive walk, and gate 0901f measured what that costs
// on a cold page cache — pnpm test:verified run 1 timed out at the 5000ms
// default here right after pnpm verify's Next build had just written .next,
// while run 2 over the same tree took 3915ms. Whole file measured 3316-4347ms
// across four clean runs before the memo, no single test >=2s. 30s matches the
// repo's DB-case convention and is headroom for that first walk, not a budget
// the suite is expected to spend.
const SCAN_BUDGET = { timeout: 30_000 };

describe("public-token routes are rate limited", SCAN_BUDGET, () => {
  it("finds every public-token resolver across app/ AND src/", () => {
    // NON-VACUITY. If the walk or the lookup match breaks, every assertion
    // below passes over an empty list — the exact failure shape this repo keeps
    // rediscovering in its own fences.
    const all = publicTokenResolvers().map((s) => s.file);
    expect(all.length).toBeGreaterThanOrEqual(9);

    const pages = publicTokenPages().map((s) => s.file);
    expect(pages.length).toBeGreaterThanOrEqual(7);
    // The ones that were missing the guard, named explicitly: if any is renamed
    // away, that is a decision someone should make on purpose.
    expect(pages).toContain("app/(public)/p/[publicToken]/encontre/page.tsx");
    expect(pages).toContain("app/(public)/p/[publicToken]/sighting/page.tsx");
    // THE TWO THAT WERE EXEMPT ON A FALSE PREMISE — the exemption text claimed
    // their write limiter ran before the lookup and it ran after. In scope now.
    expect(pages).toContain("src/modules/pets/application/sighting/report-pet-sighting.ts");
    expect(pages).toContain("src/modules/custody-disputes/application/report-dispute-tip.ts");
    // THE ONE THE OLD SCOPE COULD NOT SEE. Not a page.tsx, and a separate HTTP
    // request that scrapers fetch directly.
    expect(pages).toContain("app/(public)/p/[publicToken]/opengraph-image.tsx");
    // THE ONE THE app/-ONLY SCOPE COULD NOT SEE — the credential's decision
    // now lives in the application layer.
    expect(pages).toContain(DOOR_FILE);

    // The widening is only real if it actually reaches the new root.
    expect(all.filter((f) => f.startsWith("src/")).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps every exemption pointed at a file that still resolves a token", () => {
    // An exemption for a file that moved is a hole nobody can see. And each one
    // has to say what bounds it INSTEAD — the reason text is the contract.
    const all = new Set(publicTokenResolvers().map((s) => s.file));
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(all.has(file), `${file} is exempt but no longer resolves a token`).toBe(true);
      expect(reason.length, `${file} needs a written reason`).toBeGreaterThan(40);
    }
  });

  it("applies the per-IP read guard, in a form a resolver may use, on every resolver in scope", () => {
    // Three forms, not four: `adapter` supplies a limiter to the door and runs
    // none, so it is not evidence that a resolver guarded its own lookup.
    expect(publicTokenPages().flatMap(resolverFormViolations)).toEqual([]);
  });

  it("exercises every resolver form — none is dead weight the fence still accepts", () => {
    // NON-VACUITY for the widening itself. If `port` or `write` stops having a
    // real user, the accepted-forms list is looser than the code needs and
    // should shrink in the commit that removed the last user.
    //
    // THE POPULATION IS RESOLVERS ONLY, and `adapter` is not in the expected
    // set (re-review, 2026-09-23). The previous edit counted the door's callers
    // in here to keep `adapter` "exercised" after /p/[publicToken]/page.tsx left
    // the resolver set — which made this check unable to fire: every door
    // caller carries the adapter by construction, so the set was pinned by the
    // population, not by the code. Now an adapter-only resolver surfaces as an
    // unexpected "adapter" here (and as a violation above), and the adapter is
    // held where it belongs, on the door's callers, by `doorCallerViolations`.
    const forms = new Set(publicTokenPages().map((s) => guardForm(s.src)));
    // Pinned to the literal set, not `[...RESOLVER_FORMS]` — comparing against
    // the same constant the assertion is meant to exercise would pass even if
    // RESOLVER_FORMS silently lost a form (both sides shrink together).
    expect([...forms].sort()).toEqual(["direct", "port", "write"].sort());
  });

  it("keeps /p/[publicToken]/page.tsx off the pet row — it reads only through the door and the probe", () => {
    // The page left the resolver set when its `generateMetadata` moved onto
    // the throttled probe. A raw lookup reappearing here would put it back —
    // as an adapter-only resolver, which the checks above now reject.
    const page = allSources().find((s) => s.file === "app/(public)/p/[publicToken]/page.tsx");
    expect(page, "page.tsx moved — re-point this check").toBeDefined();
    expect(firstIndexOf(code(page?.src ?? ""), LOOKUP_MARKERS)).toBe(-1);
  });

  it("calls the guard BEFORE the route component resolves the token", () => {
    // Order is the whole point: a limiter that runs after `publicPetByToken()`
    // has already hit the database bounds nothing. Compares source positions
    // rather than trusting the call exists somewhere in the file.
    //
    // SCOPED TO THE PAGE COMPONENT, DELIBERATELY — historically because
    // /p/[publicToken]'s `generateMetadata` resolved the token above the
    // component WITHOUT the guard (guarding it too would have billed one visit
    // twice). That residual is CLOSED as of 2026-09-23: the limiter is memoised
    // per request (lib/infra/public-token-throttle.ts) and the metadata reads
    // through the guarded probe (app/(public)/p/[publicToken]/credential-probe
    // .ts), which this check judges as a whole-file resolver. The component
    // scoping stays because it is still the right unit for a page file.
    // TWO SHAPES LIVE UNDER app/, AND THE CHECK HAD ONLY EVER SEEN ONE.
    // Until 2026-08-21 every in-scope app/ resolver was a page component, so
    // this demanded `export default async function` and read the body from
    // there. Then `encontre/action.ts` came out of EXEMPT — a "use server"
    // ACTION, which has no default export at all — and the demand fired as a
    // failure on a file that had just been FIXED. The rule was never about
    // default exports; it is about the guard preceding the lookup, and for a
    // file with no component body the whole file IS the body. That is precisely
    // what `guardPrecedesLookup` computes for the src/ layer below, so the two
    // shapes now share one predicate instead of one of them owning the rule.
    const outOfOrder: string[] = [];
    let components = 0;
    let wholeFile = 0;
    for (const { file, src } of publicTokenPages()) {
      if (!file.startsWith("app/")) continue;
      // Comments blanked, offsets preserved — a `// await isPublicTokenRead…`
      // line above the lookup must not read as the guard having run.
      const componentAt = code(src).indexOf("export default async function");

      if (componentAt === -1) {
        wholeFile += 1;
        if (!guardPrecedesLookup(src)) outOfOrder.push(file);
        continue;
      }

      components += 1;
      const body = code(src).slice(componentAt);
      const lookupAt = body.indexOf(LOOKUP);
      if (lookupAt === -1) continue; // component resolves the token some other way
      const guardAt = body.indexOf(`await ${GUARD}(`);
      if (guardAt === -1 || guardAt > lookupAt) outOfOrder.push(file);
    }
    expect(outOfOrder).toEqual([]);
    // NON-VACUITY for BOTH arms. If either drops to zero the branch above it is
    // untested, and a check nobody exercises is a check nobody has proved.
    expect(components).toBeGreaterThanOrEqual(3);
    expect(wholeFile).toBeGreaterThanOrEqual(1);
  });

  it("applies the guard BEFORE the use-case resolves the token", () => {
    // Same rule as above, stated for the layer the decision moved to. The page
    // component no longer resolves the token itself, so without this the
    // ordering guarantee would simply have evaporated in the refactor.
    //
    // It covers the WRITE use-cases too, and that is the point: a hand-rolled
    // POST reaches them with no page load, so the lookup they run before their
    // limiter is an unbounded token-existence-and-status oracle. Both were
    // EXEMPT on the written claim that their limiter already ran first — it did
    // not, and nothing checked. This is the check.
    const outOfOrder = publicTokenPages()
      .filter((s) => s.file.startsWith("src/") && !guardPrecedesLookup(s.src))
      .map((s) => s.file);
    expect(outOfOrder).toEqual([]);
    // NON-VACUITY: an empty src/ slice would make the assertion above trivially
    // true, which is exactly how this fence went blind before.
    //
    // 3 → 4 on 2026-08-22, and the reason is the whole lesson of this fence.
    // `notify-owner-of-found-pet.ts` had always resolved the token BEFORE its
    // limiter — but it did so with a hand-rolled `eq(pets.publicToken, …)`,
    // which matches no LOOKUP marker, so the block "held no lookup" and the
    // ordering check had nothing to say about it. It was never exempt; it was
    // INVISIBLE. Moving it to the canonical `publicPetByToken` predicate (the
    // soft-delete fix) is what surfaced the inversion, and the limiter now runs
    // first like its two siblings. A marker list only sees the spellings it
    // knows: this count is what tells you when the set of files it can see
    // changed, so grow it deliberately and say why, never to make a red go away.
    //
    // 4 → 5 on 2026-08-28, the same lesson again, in the other file the
    // soft-delete sweep had been carrying as declared debt:
    // `lookup-pet-for-denuncia.ts` resolved its token path with a hand-rolled
    // `eq(pets.publicToken, …)` — invisible to this census AND answering with
    // an erased pet's name. The art. 16 fix moved it onto the canonical
    // predicate, which is what put it in scope here; its per-IP
    // `denuncia_lookup` limiter (WRITE form) already ran before the lookup,
    // so it entered the census compliant.
    expect(publicTokenPages().filter((s) => s.file.startsWith("src/")).length).toBe(5);
  });

  it("makes every caller of the door hand over a literal, known bucket", () => {
    // The second layer under the ADAPTER form. The type checker already forces
    // a caller to pass SOME limiter; this forces it to be a named surface.
    const callers = allSources().filter((s) => code(s.src).includes(DOOR) && !definesDoor(s.src));
    // NON-VACUITY: at least the page. An empty caller list means the door was
    // renamed and this assertion stopped seeing anything.
    expect(callers.map((s) => s.file)).toContain("app/(public)/p/[publicToken]/page.tsx");

    const problems = callers.flatMap(doorCallerViolations);
    expect(problems).toEqual([]);
  });

  it("gives each route its own limiter bucket", () => {
    // One shared bucket would let a scraper hammering /sighting spend the
    // budget of a finder loading the credential in the street, and would make
    // "which surface is being hit" unanswerable from the counters. The one
    // declared exception is SHARED_BUCKETS, and it is checked, not trusted.
    const buckets = publicTokenPages().flatMap((s) => bucketLiterals(s.src));
    expect(buckets.length).toBeGreaterThanOrEqual(3);
    expect(bucketCollisions(publicTokenPages(), SHARED_BUCKETS)).toEqual([]);
    for (const bucket of buckets) expect(KNOWN_BUCKETS.has(bucket)).toBe(true);
    for (const [file, { reason }] of Object.entries(SHARED_BUCKETS)) {
      expect(reason.length, `${file} needs a written reason`).toBeGreaterThan(40);
    }
    // NON-VACUITY for the allowance: the probe's three literals are really read.
    const probe = publicTokenPages().find(
      (s) => s.file === "app/(public)/p/[publicToken]/credential-probe.ts",
    );
    expect(probe && bucketLiterals(probe.src).sort()).toEqual([
      "public_token_encontre",
      "public_token_page",
      "public_token_sighting",
    ]);
  });

  it("makes every direct-form guard on a resolver name a literal, known bucket", () => {
    // NON-VACUITY: the census must see the direct calls it judges.
    const args = publicTokenPages().flatMap((s) => directGuardArgs(s.src));
    expect(args.length).toBeGreaterThanOrEqual(5);
    expect(publicTokenPages().flatMap(directGuardViolations)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED controls — the detector must BITE. A fence that has never failed is a
// fence nobody has proved works.
// ---------------------------------------------------------------------------

// Same budget: ONE control below — the "real tree does NOT look like that"
// half of the first test — calls publicTokenPages() over the real tree. The
// rest run against inline fixtures and cost nothing. It shares the memoised
// walk with the suites above (and pays for it in full if this describe is the
// one that runs first under a `-t` filter), so it inherits their ceiling
// instead of a hand-tuned one.
describe("the fence bites", SCAN_BUDGET, () => {
  it("flags a src resolver that takes no limiter at all", () => {
    const fixture = `
      import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
      export async function leakPet(publicToken: string) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardForm(fixture)).toBeNull();
    // And the real tree does NOT look like that.
    expect(publicTokenPages().filter((s) => guardForm(s.src) === null)).toEqual([]);
  });

  it("flags a resolver whose ONLY guard form is the adapter (re-review 2026-09-23)", () => {
    // The adapter builds a limiter for the door and runs none; a file that
    // hands it over AND reads the row itself has guarded nothing it reads.
    const adapterOnly = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: `
      export async function generateMetadata({ params }) {
        const [row] = await db.select().from(pets).where(publicPetByToken(token));
      }
      export default async function Page() {
        await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_page") });
      }`,
    };
    expect(resolverFormViolations(adapterOnly)).toEqual([
      "app/(public)/p/[publicToken]/fake/page.tsx: resolves a token but its only guard form is `adapter`",
    ]);
    // The population-level check sees it as a form outside RESOLVER_FORMS.
    expect(RESOLVER_FORMS).not.toContain(guardForm(adapterOnly.src));
    // The real tree does NOT look like that.
    expect(publicTokenPages().flatMap(resolverFormViolations)).toEqual([]);
  });

  it("flags a direct-form guard with a COMPUTED bucket — the probe's first shape", () => {
    const computed = {
      file: "app/(public)/p/[publicToken]/credential-probe.ts",
      src: "if (await isPublicTokenReadThrottled(SURFACE_BUCKET[surface])) return;",
    };
    expect(directGuardViolations(computed)).toEqual([
      "app/(public)/p/[publicToken]/credential-probe.ts: direct guard bucket must be a string literal, got `SURFACE_BUCKET[surface]`",
    ]);
    // Why the rule is needed at all: the bucket census cannot see it.
    expect(bucketLiterals(computed.src)).toEqual([]);

    const unknown = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: 'if (await isPublicTokenReadThrottled("whatever", LIMIT)) return;',
    };
    expect(directGuardViolations(unknown)).toEqual([
      'app/(public)/p/[publicToken]/fake/page.tsx: unknown direct guard bucket "whatever"',
    ]);

    const literal = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: 'if (await isPublicTokenReadThrottled("public_token_sighting")) return;',
    };
    expect(directGuardViolations(literal)).toEqual([]);
  });

  it("flags two resolvers sharing a bucket unless the share is declared — and a stale declaration", () => {
    const guard = 'await isPublicTokenReadThrottled("public_token_encontre");';
    const a = { file: "app/a/page.tsx", src: guard };
    const b = { file: "app/b/page.tsx", src: guard };
    const c = { file: "app/c/page.tsx", src: guard };
    const declared = { "app/a/page.tsx": { buckets: ["public_token_encontre"] } };
    // Undeclared collision.
    expect(bucketCollisions([a, b], {})).toEqual([
      "public_token_encontre is named by app/a/page.tsx, app/b/page.tsx",
    ]);
    // Declared, with exactly one other owner: allowed.
    expect(bucketCollisions([a, b], declared)).toEqual([]);
    // Declared, but a THIRD resolver joins: the allowance does not stretch.
    expect(bucketCollisions([a, b, c], declared)).toEqual([
      "public_token_encontre is named by app/b/page.tsx, app/c/page.tsx",
      "public_token_encontre: declared as shared by app/a/page.tsx, but 2 other resolver(s) name it",
    ]);
    // Declared for a bucket the file no longer names: stale.
    expect(
      bucketCollisions([a], { "app/a/page.tsx": { buckets: ["public_token_sighting"] } }),
    ).toEqual(["app/a/page.tsx: declares public_token_sighting as shared but does not name it"]);
  });

  it("flags a use-case that resolves the token before awaiting its port", () => {
    const inverted = `
      export async function lookupPublicCredential(input, deps) {
        const row = await deps.findPet(input.publicToken);
        if (await throttle.isThrottled()) return { status: "throttled" };
        return row;
      }`;
    expect(guardPrecedesLookup(inverted)).toBe(false);

    const correct = `
      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        const row = await deps.findPet(input.publicToken);
        return row;
      }`;
    expect(guardPrecedesLookup(correct)).toBe(true);
  });

  it("flags a caller that passes a non-literal bucket", () => {
    const dynamic = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: "const l = await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle(bucket) });",
    };
    expect(doorCallerViolations(dynamic)).toEqual([
      "app/(public)/p/[publicToken]/fake/page.tsx: limiter bucket must be a string literal, got `bucket`",
    ]);
  });

  it("still flags a non-literal bucket when the adapter is called with TWO arguments", () => {
    // THE CONTROL FOR THE 2026-08-21 REGEX WIDENING. `adapterArgs` stopped
    // requiring the closing paren so the two-argument form would parse; this is
    // the proof that it did not stop reading the first argument. A fence
    // relaxed to make a real call pass, without a control for the shape it used
    // to reject, is a fence that has quietly been switched off.
    //
    // Since 2026-08-22 (G4) the per-lookup bucket is held to the same rule, so
    // this fixture — a constant in BOTH positions — yields BOTH problems.
    const dynamic = {
      file: "app/api/v1/pets/[publicToken]/credential/route.ts",
      src: "await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle(bucket, { perLookup: { bucket: LOOKUP_BUCKET, key, limit } }) });",
    };
    expect(doorCallerViolations(dynamic)).toEqual([
      "app/api/v1/pets/[publicToken]/credential/route.ts: limiter bucket must be a string literal, got `bucket`",
      "app/api/v1/pets/[publicToken]/credential/route.ts: per-lookup bucket must be a string literal, got `LOOKUP_BUCKET`",
    ]);
  });

  it("flags a computed PER-LOOKUP bucket on its own (G4) — THE RED CONTROL", () => {
    // The surface bucket is a literal; only the narrower limiter's bucket is
    // computed. Before G4 the fence read only the adapter's first argument and
    // this passed, which is how the route shipped `bucket: LOOKUP_BUCKET`.
    const dynamic = {
      file: "app/api/v1/pets/[publicToken]/credential/route.ts",
      src: 'await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_api_credential", { perLookup: { bucket: LOOKUP_BUCKET, key, limit } }) });',
    };
    expect(doorCallerViolations(dynamic)).toEqual([
      "app/api/v1/pets/[publicToken]/credential/route.ts: per-lookup bucket must be a string literal, got `LOOKUP_BUCKET`",
    ]);
  });

  it("flags an UNKNOWN per-lookup bucket (G4)", () => {
    const unknown = {
      file: "app/api/v1/pets/[publicToken]/credential/route.ts",
      src: 'await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_api_credential", { perLookup: { bucket: "whatever", key, limit } }) });',
    };
    expect(doorCallerViolations(unknown)).toEqual([
      'app/api/v1/pets/[publicToken]/credential/route.ts: unknown per-lookup bucket "whatever"',
    ]);
  });

  it("reads a known per-lookup literal and passes it (non-vacuity for the two above)", () => {
    const literal = {
      file: "app/api/v1/pets/[publicToken]/credential/route.ts",
      src: 'await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_api_credential", { perLookup: { bucket: "public_token_api_credential_lookup", key, limit } }) });',
    };
    expect(perLookupBucketArgs(literal.src)).toEqual(['"public_token_api_credential_lookup"']);
    expect(doorCallerViolations(literal)).toEqual([]);
  });

  it("reads the bucket literal out of a TWO-argument adapter call", () => {
    // The other half of the same control: the widening must still SEE the
    // literal. A `bucketLiterals` that matched nothing would make the
    // one-bucket-per-route uniqueness assertion vacuously true.
    const twoArg = `await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_api_credential", { perLookup: { bucket: "x", key, limit } }) });`;
    expect(bucketLiterals(twoArg)).toEqual(["public_token_api_credential"]);
    expect(adapterArgs(twoArg)).toEqual(['"public_token_api_credential"']);
  });

  it("flags a caller that names an unknown bucket", () => {
    const unknown = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: `await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("whatever") });`,
    };
    expect(doorCallerViolations(unknown)).toEqual([
      'app/(public)/p/[publicToken]/fake/page.tsx: unknown limiter bucket "whatever"',
    ]);
  });

  it("flags a caller that hands the door no limiter", () => {
    const bare = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: "const l = await lookupPublicCredential({ publicToken });",
    };
    expect(doorCallerViolations(bare)).toEqual([
      "app/(public)/p/[publicToken]/fake/page.tsx: calls lookupPublicCredential( without `throttle: publicTokenThrottle(…)`",
    ]);
  });

  it("does NOT accept a port call that lives only in a comment", () => {
    // THE HOLE THIS CLOSES. `PORT_CALL` is a sentence fragment, and a docblock
    // that TELLS THE TRUTH about the contract contains it verbatim — so a
    // use-case with the sentence in prose and no limiter in code read as
    // guarded. The fence reacted to documentation instead of behaviour, which
    // is the failure mode scripts/lib/strip-comments.mjs exists for.
    const commentOnly = `
      import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
      // The caller is expected to have run: await throttle.isThrottled()
      export async function leakPet(publicToken: string) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardForm(commentOnly)).toBeNull();
    expect(guardPrecedesLookup(commentOnly)).toBe(false);
  });

  it("does NOT accept a direct guard call that lives only in a comment", () => {
    const commentOnly = `
      /* await isPublicTokenReadThrottled("public_token_page") used to run here */
      export default async function Page({ publicToken }: { publicToken: string }) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardForm(commentOnly)).toBeNull();
  });

  it("does NOT read an illustrative adapter call out of a comment", () => {
    // The false positive a Track 2 writer actually hit: an accurate comment
    // explaining WHY a dynamic bucket is banned — `publicTokenThrottle(someVariable)`
    // — was tallied as a real call site and failed the literal-bucket check.
    // A fence that penalises correct documentation teaches worse comments.
    const illustrative = {
      file: "app/(public)/p/[publicToken]/fake/page.tsx",
      src: `
        // NEVER publicTokenThrottle(someVariable): a variable bucket lets one
        // surface silently spend another surface's counter.
        await lookupPublicCredential({ publicToken, throttle: publicTokenThrottle("public_token_page") });`,
    };
    expect(adapterArgs(illustrative.src)).toEqual(['"public_token_page"']);
    expect(doorCallerViolations(illustrative)).toEqual([]);
  });

  it("flags a SECOND resolver in a file whose FIRST one is guarded", () => {
    // THE HOLE THE POSITIONAL CHECK HAD UNTIL 2026-08-21. It compared the
    // file's FIRST guard call against the file's FIRST lookup — two offsets,
    // whole-file — so a module whose opening function is guarded vouched for
    // every function below it. The shape is not exotic: it is what a use-case
    // file looks like the day someone adds a second entry point next to the
    // first, which is precisely when nobody re-reads the limiter.
    const twoFunctions = `
      import { publicPetByToken } from "@/lib/infra/public-pet-lookup";

      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return db.select().from(pets).where(publicPetByToken(input.publicToken));
      }

      export async function peekPetStatus(publicToken: string) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    // The file DOES carry a legitimate form — that was never the question.
    expect(guardForm(twoFunctions)).toBe("port");
    // The question is whether the function doing the resolving ran it.
    expect(guardPrecedesLookup(twoFunctions)).toBe(false);

    // And the guarded twin still passes, so the check is not simply refusing
    // every multi-export file.
    const bothGuarded = `
      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return db.select().from(pets).where(publicPetByToken(input.publicToken));
      }

      export async function peekPetStatus(publicToken: string, throttle) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardPrecedesLookup(bothGuarded)).toBe(true);
  });

  it("flags an UNEXPORTED helper that resolves the token above every export", () => {
    // The other end of the same rule. A block runs from one export boundary to
    // the next, so a helper declared BEFORE the first export belongs to no
    // guarded function — and nothing in the file ran a limiter before it. The
    // real tree's one unexported resolver (`findPetByPublicToken`) sits BELOW
    // the guarded door and is covered by it; this is the inverse arrangement.
    const helperAbove = `
      import { publicPetByToken } from "@/lib/infra/public-pet-lookup";

      async function findPet(publicToken: string) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }

      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return findPet(input.publicToken);
      }`;
    expect(guardPrecedesLookup(helperAbove)).toBe(false);
  });

  it("flags a SIBLING export that reuses the file's own unexported resolver", () => {
    // THE HOLE THE MARKER LIST HAD UNTIL 2026-08-21, and it was open in the one
    // file the fence names by path. `lookup-public-credential.ts` resolves the
    // token inside the unexported `findPetByPublicToken`, which the block model
    // covers because it sits BELOW the guarded door. A sibling export that calls
    // that helper reaches the same pet row — and reached it invisibly, because
    // `findPetByPublicToken(` does not contain `publicPetByToken(` (the capital
    // P is the whole difference) and contains no `.findPet(` either. Its block
    // held no lookup marker at all, so there was nothing for the ordering check
    // to be out of order WITH.
    //
    // Read from the REAL file rather than paraphrased: the shape only exists
    // because the helper is unexported and declared below the door, and a
    // hand-written fixture would be free to get that arrangement wrong.
    const real = readFileSync(join(ROOT, DOOR_FILE), "utf8");
    const withSibling = `${real}
export async function peekPetStatus(publicToken: string) {
  return findPetByPublicToken(publicToken);
}
`;
    expect(guardPrecedesLookup(withSibling)).toBe(false);
    // …and the file as it actually ships still passes, so the new marker did not
    // simply turn the door red on its own plumbing.
    expect(guardPrecedesLookup(real)).toBe(true);
  });

  it("treats an arrow DEFAULT export as a block boundary", () => {
    // The boundary rule used to enumerate the export SHAPES it knew — `export
    // async function`, `export default async function`, `export const x =
    // async`. An unrecognised shape is not a boundary, so its body was read as a
    // continuation of the export ABOVE it and INHERITED that export's guard.
    // Route handlers are written this way (`export default async (req) => …`),
    // which is exactly the layer this fence exists for.
    const fixture = `
      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return db.select().from(pets).where(publicPetByToken(input.publicToken));
      }

      export default async (req) => {
        return db.select().from(pets).where(publicPetByToken(req.token));
      };`;
    expect(guardPrecedesLookup(fixture)).toBe(false);
  });

  it("treats a NON-ASYNC `export function` as a block boundary", () => {
    // Same hole, cheapest possible spelling: drop the `async` and the shape list
    // no longer recognises it. A synchronous export cannot await a limiter, so
    // it is precisely the shape that must NOT be allowed to inherit one.
    const fixture = `
      export async function lookupPublicCredential(input, deps) {
        if (await throttle.isThrottled()) return { status: "throttled" };
        return db.select().from(pets).where(publicPetByToken(input.publicToken));
      }

      export function peekPetStatusSync(publicToken) {
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardPrecedesLookup(fixture)).toBe(false);
  });

  it("does NOT let the ADAPTER form anchor the ordering — it supplies a limiter, it runs none", () => {
    // `publicTokenThrottle("bucket")` BUILDS a limiter; nothing is consulted
    // until someone awaits `isThrottled()`. As an ordering anchor it certified
    // the opposite of the rule: a file that constructs the limiter and then
    // resolves the token itself, never asking it anything, read as "guard before
    // lookup". The four forms still CLASSIFY a file (a page that only hands the
    // port to the door is legitimate); only three of them can prove an order.
    const adapterOnly = `
      export async function renderCredential(publicToken: string) {
        const throttle = publicTokenThrottle("public_token_page");
        return db.select().from(pets).where(publicPetByToken(publicToken));
      }`;
    expect(guardForm(adapterOnly)).toBe("adapter");
    expect(guardPrecedesLookup(adapterOnly)).toBe(false);
  });

  it("flags a WRITE use-case that resolves the token before its limiter", () => {
    // The two anonymous POST use-cases (sighting, dispute tip) are reachable by
    // hand-rolled POST with no page load, so the lookup they run before the
    // limiter is an unbounded token-existence oracle — their distinct error
    // strings separate "no existe" from "no está perdida".
    const inverted = `
      export async function reportPetSighting(publicToken: string) {
        const [pet] = await db.select().from(pets).where(publicPetByToken(publicToken));
        if (!pet) return { ok: false, error: "Mascota no encontrada." };
        await enforceRateLimit(\`sighting:\${publicToken}\`, ip, { maxPerMinute: 1 });
      }`;
    expect(guardForm(inverted)).toBe("write");
    expect(guardPrecedesLookup(inverted)).toBe(false);

    const correct = `
      export async function reportPetSighting(publicToken: string) {
        await enforceRateLimit(\`sighting:\${publicToken}\`, ip, { maxPerMinute: 1 });
        const [pet] = await db.select().from(pets).where(publicPetByToken(publicToken));
        if (!pet) return { ok: false, error: "Mascota no encontrada." };
      }`;
    expect(guardPrecedesLookup(correct)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ALIAS census — the second name of the same predicate.
//
// `unerasedPetByToken` (lib/infra/public-pet-lookup.ts) is publicPetByToken
// under a name this fence deliberately does NOT match: authenticated resolvers
// spell it precisely so they are not flagged as unthrottled anonymous code.
// Until 2026-08-28 that was the census's blind spot, and it was already real:
// nothing verified that alias spellers actually ARE authenticated, and
// adoption-repository — an alias speller — is imported by the public
// /adoptar/[petToken]/postular page. A future anonymous route resolving
// through the alias in a shared module would escape this census silently.
//
// Reachability ("no alias in the anonymous import closure") is not assertable
// today for exactly that reason — shared repositories sit in both closures.
// What IS assertable: the SET of files allowed to spell the alias, pinned in
// both directions. A new speller fails until a human decides which name it
// deserves: an authenticated resolver joins this list in its own review; an
// anonymous surface must spell publicPetByToken and take the read limiter.
// Growth here is the rare, visible event — the same trade the soft-delete
// sweep makes with its declared entry prefixes ("coarser seed, mechanical
// body").
// ---------------------------------------------------------------------------

const ALIAS = "unerasedPetByToken(";

/** Reviewed authenticated resolvers — the only files that may spell the alias. */
const ALIAS_RESOLVERS = [
  "app/(app)/mis-mascotas/nueva/match/[matchedPetToken]/page.tsx",
  "app/actions/return-to-owner.ts",
  // Added 2026-08-30 with the native adopción doors (WU-U). This entry is the
  // "human decides which name it deserves" event the header above describes, so
  // the decision is written here rather than assumed from the file's location.
  //
  // IT IS THE CITIZEN-FACING HALF SPLIT OUT OF `adoption-repository.ts`, one
  // line below, which was already a pinned speller — so the alias did not enter
  // the tree here, it MOVED. The split was forced by `lint:file-size` (1521
  // against a hard 1500) and it lands five methods a citizen reaches in their
  // own module.
  //
  // WHY IT IS AUTHENTICATED, TRACED RATHER THAN ASSUMED — this is the part that
  // was got wrong once and cost a rejection. Two of the five spell the alias:
  //   · `findPetForApplication` ← `submitAdoptionApplication`, whose step 1 is
  //     `if (!applicant) return …`, before the lookup at step 3. The WEB action
  //     does admit an anonymous caller and is refused exactly there.
  //   · `findPetForPublicDetail` ← `readAdoptionDetail` ← `GET /api/v1/
  //     adoptions/{petToken}` and nothing else, which runs `requireLiveUser`
  //     first.
  // The module's own header claimed the opposite — that two methods serve
  // sessionless requests on the web's public `/adoptar/{token}` — and a reviewer
  // reading it turned the lane back on this very fence. That page never calls
  // this module: it carries its own inline query spelling `publicPetByToken` and
  // taking `isPublicTokenReadThrottled`. The header was corrected in the same
  // commit as this line, because a pin entry and the file's own account of
  // itself must not be able to disagree.
  "src/modules/adoption/infrastructure/adoption-public-reads.ts",
  "src/modules/adoption/infrastructure/adoption-repository.ts",
  "src/modules/foster/infrastructure/foster-repository.ts",
  "src/modules/rehome/infrastructure/rehome-repository.ts",
  "src/modules/return-to-owner/application/actor-cancel-proposal.ts",
  "src/modules/return-to-owner/application/org-accept-owner-return.ts",
  "src/modules/return-to-owner/application/org-reject-owner-return.ts",
  "src/modules/return-to-owner/application/owner-accept-return.ts",
  "src/modules/return-to-owner/application/owner-propose-return-to-org.ts",
  "src/modules/return-to-owner/application/owner-reject-return.ts",
  "src/modules/return-to-owner/application/propose-return-as-refugio.ts",
  "src/modules/return-to-owner/application/propose-return-as-vecino.ts",
  "src/modules/transfers/infrastructure/transfers-repository.ts",
] as const;

describe("the authenticated alias is a pinned set, not an open door", SCAN_BUDGET, () => {
  it("every file spelling unerasedPetByToken( is a reviewed authenticated resolver — in both directions", () => {
    const spellers = allSources()
      .filter((s) => code(s.src).includes(ALIAS))
      .map((s) => s.file);
    // toEqual over sorted arrays checks both directions at once: a NEW speller
    // appears on the left and fails; a REMOVED one leaves a stale pin that
    // fails too, so this list cannot rot in either direction.
    expect(spellers).toEqual([...ALIAS_RESOLVERS].sort((a, b) => a.localeCompare(b)));
  });

  it("does not count the alias out of comments or imports-only mentions", () => {
    // The call-shaped needle: `unerasedPetByToken(`. An import statement ends
    // in a comma or brace, never an open paren, and comments are stripped —
    // same discipline as every other predicate in this file.
    const importOnly = 'import { unerasedPetByToken } from "@/lib/infra/public-pet-lookup";';
    expect(code(importOnly).includes(ALIAS)).toBe(false);
    const commented = "// resolves via unerasedPetByToken(token) since the custody unit";
    expect(code(commented).includes(ALIAS)).toBe(false);
    const realCall = "const [pet] = await db.select().from(pets).where(unerasedPetByToken(token));";
    expect(code(realCall).includes(ALIAS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ROUTE census — every anonymous route whose URL carries an identifier.
//
// WHY A SECOND CENSUS (audit A03-3, 2026-09-18). Everything above enumerates
// CALL SITES of `publicPetByToken`: its subject is code that resolves a PET
// token. `/refugios/{orgToken}` resolves an ORG token and `/r/invite/{token}`
// an invitation, so neither could ever enter that census however unthrottled
// they were — and both were, with no limiter at all. Adding their lookup
// helpers to LOOKUP_MARKERS would be the trap this file already names: a
// marker list sees only the spellings it knows, and the next org-token page
// would read through a helper nobody added.
//
// So the subject comes from the ROUTE TREE instead. Under the anonymous roots,
// a route entry file with a `[segment]` in its path takes an identifier from
// whoever types the URL, and that is what needs a budget, whatever kind of
// token it happens to be. Nothing has to be registered for a new one to be in
// scope; it is in scope by being a route with a dynamic segment.
//
// Files the pet census above already governs (token resolvers and callers of
// the door) are left to it. Its forms and ordering rules are the stricter
// ones, and one file judged by two rules that can disagree is a file whose
// verdict depends on which test ran.
//
// THE ORDERING RULE: the first thing a handler awaits, apart from reading its
// own request — `params`, `searchParams`, `headers()`, `cookies()`, the local
// `callerIpFromHeaders()` wrapper — must be the limiter. That names the
// subject (work done before the budget) instead of a list of query spellings,
// and it counts a session read as work: `getUser()` is a GoTrue round-trip.
// `generateMetadata` is not a handler here. (The residual it used to leave on
// /p/{token} is closed: it now reads through the guarded, memoised probe.)
//
// STATED BLIND SPOTS. Server actions under these segments (`action.ts`,
// `actions.ts`) are POST endpoints but not route entry files; the pet census
// covers the ones that resolve a pet token. A layout renders inside its page's
// request rather than as a route, so a layout that read by the URL token
// before the page's guard would not be seen here.
// ---------------------------------------------------------------------------

/** The trees an anonymous caller reaches without a session. */
const ROUTE_ROOTS = ["app/(public)/", "app/r/", "app/libreta/"] as const;

/** Next's file conventions for a separately requestable route. */
const ROUTE_ENTRY_FILES = new Set([
  "page.tsx",
  "page.ts",
  "route.ts",
  "opengraph-image.tsx",
  "twitter-image.tsx",
]);

/** Awaits that only read the request itself — allowed before the limiter. */
const REQUEST_SHAPE_AWAIT =
  /^(?:(?:\w+\.)?params\b|searchParams\b|headers\(\)|cookies\(\)|callerIpFromHeaders\(\))/;

/** The two limiter calls a route entry file may lead with. */
const ROUTE_GUARD_AWAIT = /^(?:isPublicTokenReadThrottled|enforceRateLimit)\(/;

/** A handler block: the page/image component or an HTTP method. */
const HANDLER_BLOCK =
  /^[ \t]*export\s+(?:default\b|(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b|const\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD)\b)/;

/**
 * Routes in scope that legitimately lead with something else. Each names the
 * reason and what bounds it instead. Empty on purpose: every route this census
 * found on its first run already led with a limiter or was made to.
 */
const ROUTE_EXEMPT: Record<string, string> = {};

function isRouteEntry(file: string): boolean {
  if (!ROUTE_ROOTS.some((root) => file.startsWith(root))) return false;
  const parts = file.split("/");
  const base = parts.at(-1) ?? "";
  if (!ROUTE_ENTRY_FILES.has(base)) return false;
  // A dynamic segment anywhere in the path: [x], [...x] or [[...x]].
  return parts.slice(0, -1).some((segment) => /^\[.+\]$/.test(segment));
}

/** Every file the pet census above governs, so this one does not judge it twice. */
function petCensusFiles(): Set<string> {
  const doorCallers = allSources().filter((s) => code(s.src).includes(DOOR) && !definesDoor(s.src));
  return new Set([...publicTokenResolvers(), ...doorCallers].map((s) => s.file));
}

function identifierRoutes(): Source[] {
  const governed = petCensusFiles();
  return allSources().filter((s) => isRouteEntry(s.file) && !governed.has(s.file));
}

/** The text right after each `await` in a block, whitespace skipped, in order. */
function awaitedExpressions(block: string): string[] {
  const out: string[] = [];
  const re = /\bawait\b\s*/g;
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    out.push(block.slice(m.index + m[0].length, m.index + m[0].length + 60));
  }
  return out;
}

/** Why a route entry file fails the rule, or null when it passes. */
function routeGuardProblem(src: string): string | null {
  const handlers = exportBlocks(code(src)).filter((b) => HANDLER_BLOCK.test(b));
  if (handlers.length === 0) return "no handler export found";
  for (const block of handlers) {
    const first = awaitedExpressions(block).find((e) => !REQUEST_SHAPE_AWAIT.test(e));
    if (first === undefined) return "the handler awaits nothing but its request: no limiter ran";
    if (!ROUTE_GUARD_AWAIT.test(first)) {
      return `the first awaited work is \`${first.split("\n")[0].trim()}\`, not the limiter`;
    }
  }
  return null;
}

/** The bucket literal each limiter call names, in code. */
function routeBucketLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /(?:isPublicTokenReadThrottled|enforceRateLimit)\(\s*"([^"]+)"/g;
  const c = code(src);
  for (let m = re.exec(c); m !== null; m = re.exec(c)) out.push(m[1]);
  return out;
}

describe(
  "every anonymous route with an identifier in its URL spends a limiter first",
  SCAN_BUDGET,
  () => {
    it("finds the identifier routes beyond the pet census — org tokens and invitations included", () => {
      const files = identifierRoutes().map((s) => s.file);
      // NON-VACUITY. Seven on the day this landed; a drop means the walk or the
      // segment match broke, and every assertion below would pass over nothing.
      expect(files.length).toBeGreaterThanOrEqual(7);
      // The two A03-3 found, named so a rename away from them is a decision.
      expect(files).toContain("app/(public)/refugios/[orgToken]/page.tsx");
      expect(files).toContain("app/r/invite/[token]/page.tsx");
      // A route handler, not only pages.
      expect(files).toContain("app/(public)/transparencia/datos/[dataset]/route.ts");
      // The walk reaches every root it claims.
      for (const root of ROUTE_ROOTS) {
        expect(
          files.some((f) => f.startsWith(root)),
          `nothing found under ${root}`,
        ).toBe(true);
      }
      // And it does not re-judge what the pet census owns.
      expect(files).not.toContain("app/(public)/p/[publicToken]/page.tsx");
      expect(files).not.toContain("app/(public)/adoptar/[petToken]/page.tsx");
    });

    it("keeps every exemption pointed at a route that is still in scope", () => {
      const inScope = new Set(identifierRoutes().map((s) => s.file));
      for (const [file, reason] of Object.entries(ROUTE_EXEMPT)) {
        expect(inScope.has(file), `${file} is exempt but no longer in scope`).toBe(true);
        expect(reason.length, `${file} needs a written reason`).toBeGreaterThan(40);
      }
    });

    it("leads every handler with the limiter", () => {
      const problems = identifierRoutes()
        .filter((s) => ROUTE_EXEMPT[s.file] === undefined)
        .map((s) => [s.file, routeGuardProblem(s.src)] as const)
        .filter(([, problem]) => problem !== null)
        .map(([file, problem]) => `${file}: ${problem}`);
      expect(problems).toEqual([]);
    });

    it("gives each route its own literal bucket", () => {
      const perFile = identifierRoutes()
        .filter((s) => ROUTE_EXEMPT[s.file] === undefined)
        .map((s) => ({ file: s.file, buckets: routeBucketLiterals(s.src) }));
      const unnamed = perFile.filter((f) => f.buckets.length === 0).map((f) => f.file);
      expect(unnamed, "a limiter bucket must be a string literal").toEqual([]);
      const all = perFile.flatMap((f) => f.buckets);
      expect(new Set(all).size).toBe(all.length);
    });
  },
);

describe("the route census bites", SCAN_BUDGET, () => {
  it("flags the /refugios/{orgToken} shape it was written for: session and queries, no limiter", () => {
    const before = `
      export default async function RefugioPage({ params }) {
        const { orgToken } = await params;
        const supabase = await createClient();
        const { data } = await supabase.auth.getUser();
        const [org] = await Promise.all([queryOrgPublicProfile(orgToken)]);
        return org;
      }`;
    expect(routeGuardProblem(before)).toMatch(/first awaited work is `createClient\(\)/);
  });

  it("flags a limiter that runs after the read it is meant to bound", () => {
    const late = `
      export default async function InvitePage({ params }) {
        const { token } = await params;
        const [row] = await db.select().from(invitations).where(eq(invitations.token, token));
        if (await isPublicTokenReadThrottled("invite_resolve")) return null;
        return row;
      }`;
    expect(routeGuardProblem(late)).toMatch(/first awaited work is `db\.select\(\)/);
  });

  it("accepts reading the request first: params, searchParams, headers, the IP wrapper", () => {
    const ok = `
      export default async function Page({ params, searchParams }) {
        const { code } = await params;
        const { nueva } = await searchParams;
        const ip = await callerIpFromHeaders();
        try {
          await enforceRateLimit("denuncia_receipt", ip, { maxPerMinute: 30 });
        } catch (err) {
          return null;
        }
        const [row] = await db.select().from(reports);
        return row;
      }`;
    expect(routeGuardProblem(ok)).toBeNull();
    expect(routeBucketLiterals(ok)).toEqual(["denuncia_receipt"]);
  });

  it("does not accept a limiter that lives only in a comment", () => {
    const commentOnly = `
      export default async function Page({ params }) {
        const { orgToken } = await params;
        // await isPublicTokenReadThrottled("org_public_profile") runs here
        const org = await queryOrgPublicProfile(orgToken);
        return org;
      }`;
    expect(routeGuardProblem(commentOnly)).toMatch(/queryOrgPublicProfile/);
  });

  it("judges every HTTP method of a route handler, not only the first", () => {
    const halfGuarded = `
      export async function GET(request, ctx) {
        const { dataset } = await ctx.params;
        await enforceRateLimit("open_data_dataset", ip, { maxPerMinute: 30 });
        return Response.json(await build(dataset));
      }
      export async function POST(request) {
        return Response.json(await build(await request.json()));
      }`;
    expect(routeGuardProblem(halfGuarded)).toMatch(/first awaited work is `build\(/);
  });

  it("does not treat generateMetadata as the handler", () => {
    // The documented residual: metadata resolves outside the guard so one
    // visit is not billed twice. The page component still has to lead with it.
    const metadataFirst = `
      export async function generateMetadata({ params }) {
        const org = await queryOrgPublicProfile((await params).orgToken);
        return { title: org?.displayName };
      }
      export default async function Page({ params }) {
        const { orgToken } = await params;
        if (await isPublicTokenReadThrottled("org_public_profile")) return null;
        return queryOrgPublicProfile(orgToken);
      }`;
    expect(routeGuardProblem(metadataFirst)).toBeNull();
  });

  it("reads the dynamic segment off the path, not off the file's contents", () => {
    expect(isRouteEntry("app/(public)/refugios/[orgToken]/page.tsx")).toBe(true);
    expect(isRouteEntry("app/(public)/docs/[...slug]/page.tsx")).toBe(true);
    expect(isRouteEntry("app/(public)/refugios/page.tsx")).toBe(false);
    expect(isRouteEntry("app/(public)/refugios/[orgToken]/OrgHero.tsx")).toBe(false);
    expect(isRouteEntry("app/org/[orgToken]/page.tsx")).toBe(false);
  });
});
