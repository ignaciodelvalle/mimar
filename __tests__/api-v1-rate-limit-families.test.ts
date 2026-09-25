// Every per-IP rate-limit bucket on `/api/v1` belongs to a declared FAMILY.
//
// THE DEFECT THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `lib/infra/public-token-throttle.ts` records what happened the last time a SET
// of rate-limited surfaces was described in prose: the comment said "the four
// HTML surfaces", there were five, and the fifth — `/adoptar/{petToken}` — spent
// months reading as a deliberate exception rather than as a gap, because a count
// in a comment is a claim about a set that nothing checks.
//
// WU-EAS-2 re-derived the ceilings for `app/api/v1/me/**` and
// `app/api/v1/localities/**` against Argentine carrier NAT and deliberately left
// ten sibling buckets on the older numbers. That is exactly the shape that
// defect had: same caller, same phone, same gateway, different ceiling one screen
// later. So the list of what moved and what did not is NOT written in prose. It
// is `API_V1_IP_BUCKET_FAMILIES`, and this file is what makes it true.
//
// THE TEN LANDED ON 2026-08-27 and the map is what carried the change: every one
// of them was re-derived into a family, three families were added because the five
// writes did not share a per-user anchor, and `route-local` — what `pre-cgnat`
// became — is now EMPTY, with an assertion below that keeps it empty. This file
// did not have to be rewritten to notice any of that; it had to be told the new
// constants' names. That is the property the map was for.
//
// WHAT IS ASSERTED, AND WHY BOTH DIRECTIONS
// ---------------------------------------------------------------------------
//   source → map: a per-IP bucket that exists in a route but is in no family is
//     a route that landed without anybody deciding what its ceiling should be.
//   map → source: a family entry with no bucket behind it is a claim about a
//     surface that no longer has it, which is how an inventory quietly becomes
//     fiction while still reading as complete.
//
// AND, SINCE 2026-08-26, THE ASSIGNMENT ITSELF — the hole a review found in the
// two directions above. Both of them are SET assertions: they prove every bucket
// is named somewhere in the map and that the map names nothing extra. Neither
// looks at WHICH family a bucket was filed under. A write route filed as
// `authenticated-read` would be in the map, would have a bucket behind it, would
// silently run at 600/min instead of 120/min — five times its intended ceiling —
// and would pass every assertion this file had.
//
// That is the SAME defect this file was written about, one level up. The prose
// in `public-token-throttle.ts` miscounted a set; a set assertion that ignores
// the labels miscounts the mapping. "The fence" has to fence the misdeclared
// route and not only the undeclared one, so two more things are derived from
// source rather than trusted:
//
//   CEILING → FAMILY. Every family call site passes a shared constant from
//     `lib/infra/api-v1-limits.ts` as the third argument to its limiter. That
//     identifier says what the route ACTUALLY spends, so the declared family must
//     be the one that constant belongs to. A constant declared inside the route
//     file means the route owns its own number, which is exactly what
//     `route-local` declares — and since 2026-08-27 no route does, which is why
//     the default is now a trap rather than a category.
//
//   HTTP METHOD → FAMILY. A bucket spent inside `export async function GET`
//     cannot belong to a write family and vice versa. This is the half that
//     catches the review's scenario at its source: mislabelling a POST route as
//     `authenticated-read` requires ALSO handing it the read constant, and the
//     handler it sits in gives that away. `route-local` is exempt from THIS half
//     only, because it is a mechanism rather than a direction — but it is not
//     exempt from the ceiling check, and since 2026-08-27 it is not exempt from
//     being empty either.
//
// HOW A BUCKET IS RECOGNISED AS PER-IP, and the blind spot that comes with it.
// The `api_v1_*` bucket literals in a route are collected, then partitioned by
// what they are KEYED on at the call site: `callerIp(` in the same call means
// per-IP, anything else (a `live.user.id`) means per-user. That is a regex over
// source, so it is defeated by a call whose arguments span a shape this does not
// parse — which is a real limit and is why the NON-VACUITY floor below exists:
// a parser that silently stops matching produces an empty set, and an empty set
// passes every equality assertion in this file.

import { globSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  API_V1_ACCOUNT_SECURITY_IP_LIMIT,
  API_V1_ACCOUNT_SECURITY_USER_LIMIT,
  API_V1_AUTHENTICATED_READ_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT,
  API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE,
  API_V1_INBOX_STATE_IP_LIMIT,
  API_V1_INBOX_STATE_USER_LIMIT,
  API_V1_IP_BUCKET_FAMILIES,
  API_V1_IP_FAMILIES,
  API_V1_MEDIA_UPLOAD_IP_LIMIT,
  API_V1_MEDIA_UPLOAD_USER_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT,
  API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT,
  API_V1_PET_RECORD_WRITE_IP_LIMIT,
  API_V1_PET_RECORD_WRITE_USER_LIMIT,
  API_V1_PET_REGISTRATION_IP_LIMIT,
  API_V1_PET_REGISTRATION_USER_LIMIT,
  API_V1_PUBLIC_REFERENCE_IP_LIMIT,
  API_V1_SIMULTANEOUS_CALLERS,
  type ApiV1IpFamily,
} from "@/lib/infra/api-v1-limits";

const ROUTE_GLOB = "app/api/v1/**/route.ts";

/**
 * NON-VACUITY FLOOR. A glob that stops matching, or a regex that stops parsing,
 * yields an empty set — and an empty set is equal to nothing at all, which reads
 * exactly like a clean run. Raise this when the surface grows; that is the whole
 * job of the number, and `check-api-v1-envelope.ts` has two written paragraphs
 * about the two times its own floor drifted instead.
 *
 * 20 → 29 with the turnos door, and the nine it moved by are NOT this lane's
 * two. They are the drift the sibling paragraphs predict: the map holds 29
 * buckets on this tree and this floor still said 20, so seven buckets' worth of
 * slack had accumulated across the doors that landed since it was last touched.
 * It never went red, and that is exactly the failure mode — a floor is satisfied
 * by any number above it, so it loosens in SILENCE. Recounted from
 * `API_V1_IP_BUCKET_FAMILIES` rather than incremented from 20.
 *
 * 29 → 30 at the 2026-08-30 integration merge, with the reclamar door
 * (`me/pet-claims`). RECOUNTED, not incremented, and the distinction had teeth
 * this time: two lanes in that window each declared a bucket count for their own
 * worktree (30 and 32) and a third lane was turned back, so any arithmetic over
 * the reported numbers would have been wrong in one direction or the other.
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` on the MERGED tree is 30.
 *
 * 30 → 33 with the adopción doors (WU-U), and this row is the one that proves
 * the paragraph above rather than merely repeating it. The lane that wrote these
 * routes declared 32 for its own worktree — the very "32" named two paragraphs
 * up as the number that would have been wrong — because it counted against a
 * tree carrying neither turnos nor the reclamar door. Both landed while it was
 * open. Carrying 32 across the rebase would have pinned a floor SATISFIED by the
 * real tree and silently loosened by one, which is the failure this whole comment
 * is about. Recounted on the merged tree with all three adopción buckets and the
 * reclamar door present: `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 33.
 *
 * RECOUNTED AGAIN, 2026-08-30, with the denuncia door (WU-T) added: 34. Read off
 * the tree with `Object.keys(...).length`, not obtained by adding 1 to the 33
 * above — which is the instruction this comment has now survived three doors
 * saying, and the value it would have produced this time happens to agree. That
 * agreement is not the reason it is written down; the recount is.
 *
 * 33 → 34 with the BUSCAR half of turnos, which adds ONE bucket for TWO routes
 * (`api_v1_appointment_search_ip`, shared by `/api/v1/appointments` and
 * `/api/v1/appointments/{offeringToken}`) and no bucket at all for the booking
 * write — `book` lands beside `cancel` on `POST /me/appointments` and spends the
 * counter that route already has. Recounted on this worktree:
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 34.
 *
 * WHOEVER MERGES THIS ALONGSIDE THE DENUNCIAS LANE MUST RECOUNT, NOT ADD ONE.
 * That lane's hand-off carries an `api_v1_welfare_reports_ip` entry, and 34 + 1
 * is only right if nothing else lands in between — which is the assumption that
 * produced every stale figure named in the paragraphs above.
 *
 * 35 AT THE 2026-08-30 INTEGRATION MERGE, and this is the first window in which
 * BOTH lanes wrote that instruction and BOTH were the other's counter-example.
 * Each declared 34 for its own worktree and each was right about a tree the
 * other was about to invalidate. Recounted on the merged tree:
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 35 —
 * `api_v1_welfare_reports_ip` and `api_v1_appointment_search_ip` on top of the
 * 33 that were already here.
 *
 * THIS IS THE ONE OF THE THREE PINS THAT WOULD HAVE LOOSENED IN SILENCE. The
 * CGNAT aggregate below is a `toBe`, so it goes red on its own the instant the
 * map grows; this line is a floor with `toBeGreaterThanOrEqual`, so taking
 * either lane's 34 across the merge would have left it satisfied, green, and
 * slack by one — exactly the drift the "20 → 29" paragraph at the top of this
 * comment had to repair, arriving for the fourth time.
 *
 * 35 → 36 with the MUDANZA door (WU-P, `pets/{token}/move`), which adds ONE
 * bucket because the route is POST-only: the form's two reads are
 * `/pets/{token}` and `/localities`, both of which already carry their own, so
 * there is no read bucket to declare. RECOUNTED on this worktree —
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 36 — and not obtained by
 * adding one to the 35 above, which is the instruction this comment has now
 * survived five doors saying.
 *
 * 36 → 38 with the DEVOLUCIÓN door (WU-P, `pets/{token}/return`), which unlike
 * mudanza is GET+POST and therefore brings two: `api_v1_return_read_ip` joins
 * `authenticated-read` and `api_v1_return_write_ip` joins `authenticated-write`.
 * RECOUNTED on this worktree with the mudanza bucket already present —
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 38 — and not 36 + 2, which
 * happens to give the same answer only because this lane is the one that added
 * both. WHOEVER MERGES THIS ALONGSIDE ANOTHER LANE MUST RECOUNT.
 *
 * 38 → 39 with the native IDENTITY door (`POST /me/identity`, PO 2026-09-05),
 * which adds ONE bucket because the route is POST-only: there is no read half to
 * declare — the screen already holds `profilePending` from `/me`, and the write's
 * own response carries the fresh user rather than sending the client back for it.
 * RECOUNTED on this worktree, `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is
 * 39, and not obtained by adding one to the 38 above — the instruction this
 * comment has now survived six doors saying.
 *
 * 39 → 50 with the REACTIVATION door (D4, `POST /me/reactivate`), and ten of
 * those eleven are not this door's: the floor had sat at 39 while the map grew
 * to 49 (foster, cases, poster, map, profile, rehome, reminders…), which is the
 * exact silent loosening this comment exists to name. D4 adds ONE bucket,
 * `api_v1_me_reactivate_ip`. RECOUNTED on this worktree —
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 50 — not 39 + 1.
 *
 * 50 → 52 with the MIS DENUNCIAS door (M16): `api_v1_me_welfare_reports_read_ip`
 * and `api_v1_me_welfare_report_detail_ip`. RECOUNTED on this worktree —
 * `Object.keys(API_V1_IP_BUCKET_FAMILIES).length` is 52.
 */
const MIN_IP_BUCKETS = 52;

/**
 * Collects `enforceRateLimit`-style bucket literals from a route's source and
 * says which are keyed on the caller IP.
 *
 * The routes use two spellings — `enforceRateLimit(bucket, callerIp(...), limit)`
 * directly, and a local `spendBudget(bucket, callerIp(...), limit)` helper — so
 * the match is on the ARGUMENT SHAPE rather than on the callee name. A bucket
 * literal followed by `callerIp(` before the next `)` of the call is per-IP.
 */
function ipBucketsIn(source: string): string[] {
  const found: string[] = [];
  const call = /"(api_v1_[a-z0-9_]+)"\s*,\s*([^;]{0,200}?)\)/gs;
  for (const match of source.matchAll(call)) {
    const [, bucket, rest] = match;
    if (rest.includes("callerIp(")) found.push(bucket);
  }
  return found;
}

function collectIpBuckets(): string[] {
  const files = globSync(ROUTE_GLOB);
  const buckets = new Set<string>();
  for (const file of files) {
    for (const bucket of ipBucketsIn(readFileSync(file, "utf8"))) buckets.add(bucket);
  }
  return [...buckets].sort();
}

// ---------------------------------------------------------------------------
// The assignment parser — a SECOND, stricter read of the same call sites
// ---------------------------------------------------------------------------

/**
 * Which family a shared ceiling constant belongs to.
 *
 * Keyed by IDENTIFIER, because the identifier is what appears at the call site
 * and the call site is the only place that says what a route really spends.
 * Renaming an export therefore fails this file loudly instead of silently
 * dropping a route into the `route-local` bucket below — which is the failure
 * this table would otherwise introduce.
 */
const FAMILY_OF_SHARED_CEILING: Readonly<Record<string, ApiV1IpFamily>> = {
  API_V1_AUTHENTICATED_READ_IP_LIMIT: "authenticated-read",
  API_V1_AUTHENTICATED_WRITE_IP_LIMIT: "authenticated-write",
  API_V1_ACCOUNT_SECURITY_IP_LIMIT: "account-security",
  API_V1_INBOX_STATE_IP_LIMIT: "inbox-state",
  API_V1_PUBLIC_REFERENCE_IP_LIMIT: "public-reference",
  API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT: "pet-disclosure-write",
  API_V1_PET_RECORD_WRITE_IP_LIMIT: "pet-record-write",
  API_V1_PET_REGISTRATION_IP_LIMIT: "pet-registration",
  API_V1_MEDIA_UPLOAD_IP_LIMIT: "media-upload",
  // KEYED BY THE IDENTIFIER, which is why this table names a constant it does
  // not import: what the parser reads is the TEXT a route passes as its third
  // argument, and importing the value would prove nothing about the call site.
  API_V1_ADOPTION_APPLICATION_IP_LIMIT: "adoption-application",
};

/**
 * Families whose buckets may only be spent by a read handler, and vice versa.
 *
 * EVERY FAMILY EXCEPT `route-local` HAS TO BE IN ONE OF THESE TWO, or the method
 * fence below silently stops applying to it — a family missing from both lists
 * is exempt from the check that catches a write route wearing a read ceiling,
 * which is the failure this whole describe block exists for. The exhaustiveness
 * test underneath is what makes that impossible to do by omission.
 */
const READ_FAMILIES: readonly ApiV1IpFamily[] = ["authenticated-read", "public-reference"];
const WRITE_FAMILIES: readonly ApiV1IpFamily[] = [
  "authenticated-write",
  "account-security",
  "inbox-state",
  "pet-disclosure-write",
  "pet-record-write",
  "pet-registration",
  "media-upload",
  "adoption-application",
];

type IpBucketSite = {
  readonly bucket: string;
  readonly file: string;
  /** The identifier passed as the ceiling — shared constant or route-local. */
  readonly ceiling: string;
  /** The exported handler the call sits inside, or null if it sits outside one. */
  readonly method: string | null;
};

/**
 * Every per-IP limiter CALL SITE, with the ceiling it spends and the handler it
 * lives in.
 *
 * Deliberately stricter than `ipBucketsIn` above: it requires the three-argument
 * shape `(bucketLiteral, callerIp(...), CEILING)` rather than merely finding
 * `callerIp(` somewhere in the argument list. A stricter parser has a bigger
 * blind spot, so the two are cross-checked for EQUALITY below instead of one
 * being trusted — a parser that quietly stops matching produces a smaller set,
 * and a smaller set satisfies every "is it in the map" assertion in this file.
 *
 * The handler is resolved by position: the last `export [async] function METHOD(`
 * before the call. That is a lexical approximation and it is fine for these
 * files, where every route is a flat list of exported handlers — but it is why
 * `method` is nullable and why a null is treated as a failure rather than as
 * "exempt".
 */
function collectIpBucketSites(): IpBucketSite[] {
  const call =
    /"(api_v1_[a-z0-9_]+)"\s*,\s*(callerIp\([^)]*\)|[A-Za-z0-9_.]+)\s*,\s*([A-Za-z0-9_.]+)\s*[,)]/gs;
  const handler = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

  const sites: IpBucketSite[] = [];
  for (const file of globSync(ROUTE_GLOB)) {
    const source = readFileSync(file, "utf8");
    const handlers = [...source.matchAll(handler)].map((m) => ({
      at: m.index ?? 0,
      method: m[1],
    }));

    for (const match of source.matchAll(call)) {
      const [, bucket, keyedOn, ceiling] = match;
      if (!keyedOn.startsWith("callerIp(")) continue; // per-user bucket, not ours
      const at = match.index ?? 0;
      const enclosing = handlers.filter((h) => h.at < at).at(-1) ?? null;
      sites.push({
        bucket,
        file: file.replaceAll("\\", "/"),
        ceiling,
        method: enclosing?.method ?? null,
      });
    }
  }
  return sites;
}

/** The family a call site's ceiling identifier implies. */
function familyFromCeiling(ceiling: string): ApiV1IpFamily {
  // A route-local constant IS the declaration that the route owns its own
  // number, which is what `route-local` means. Nothing else in this file has to
  // enumerate them, which matters: a list here would be one more place to keep in
  // step. Since 2026-08-27 nothing is filed under it — so this default is now the
  // way a NEW route with its own literal announces itself, and the assertions
  // below turn that announcement into a failure.
  return FAMILY_OF_SHARED_CEILING[ceiling] ?? "route-local";
}

describe("/api/v1 per-IP rate-limit buckets — every one has a declared family", () => {
  const buckets = collectIpBuckets();

  it("finds enough buckets that an equality assertion means something", () => {
    // Vacuity first: every other assertion in this file is an equality against a
    // set this function produced, so a function that produced nothing would make
    // all of them pass.
    expect(buckets.length).toBeGreaterThanOrEqual(MIN_IP_BUCKETS);
  });

  it("declares a family for every per-IP bucket the routes actually spend", () => {
    const undeclared = buckets.filter((b) => !(b in API_V1_IP_BUCKET_FAMILIES));
    expect(
      undeclared,
      "a per-IP bucket with no family is a route that landed without anybody " +
        "deciding what its ceiling should be — add it to API_V1_IP_BUCKET_FAMILIES",
    ).toEqual([]);
  });

  it("has no family entry for a bucket that no longer exists", () => {
    const orphaned = Object.keys(API_V1_IP_BUCKET_FAMILIES).filter((b) => !buckets.includes(b));
    expect(
      orphaned,
      "an inventory that still lists a removed bucket reads as complete while " +
        "describing a surface that changed",
    ).toEqual([]);
  });
});

describe("/api/v1 per-IP buckets — every one is filed under the RIGHT family", () => {
  const sites = collectIpBucketSites();
  const buckets = collectIpBuckets();

  it("sees the same buckets the membership parser sees", () => {
    // CROSS-CHECK BEFORE ANY VERDICT. Everything below is derived from the
    // stricter three-argument parser, which can stop matching a call whose shape
    // drifts — an argument split across a helper, a ceiling built inline. It
    // would then examine FEWER call sites and report a clean run, exactly the
    // vacuity failure MIN_IP_BUCKETS exists for one parser up. Two independent
    // reads of the same files must agree, or neither is evidence.
    expect(
      [...new Set(sites.map((s) => s.bucket))].sort(),
      "the assignment parser and the membership parser disagree about which " +
        "buckets exist — one of them stopped matching a call site, and the " +
        "assertions below are only meaningful over the set they share",
    ).toEqual(buckets);
  });

  it("resolves an enclosing handler for every call site", () => {
    // A null method is not "exempt from the method fence"; it is the fence
    // failing to see. Said out loud so a future limiter hoisted into a shared
    // helper fails here instead of quietly opting itself out below.
    const orphaned = sites.filter((s) => s.method === null).map((s) => `${s.bucket} (${s.file})`);
    expect(
      orphaned,
      "a per-IP limiter that does not sit inside an exported handler cannot be " +
        "checked against its family's direction — move it into the handler or " +
        "teach this file how to resolve it",
    ).toEqual([]);
  });

  it("files every bucket under the family whose ceiling it actually spends", () => {
    // THE REVIEW'S SCENARIO, asserted at the only place that cannot lie about
    // it: the argument the route hands the limiter. A bucket declared
    // `authenticated-read` while spending API_V1_AUTHENTICATED_WRITE_IP_LIMIT —
    // or the reverse, which is the dangerous direction because it is a 5×
    // LOOSENING — fails here even though it is present in the map, has a bucket
    // behind it, and satisfies both set assertions above.
    const mismatched = sites
      .map((s) => ({
        bucket: s.bucket,
        file: s.file,
        declared: API_V1_IP_BUCKET_FAMILIES[s.bucket],
        spends: familyFromCeiling(s.ceiling),
        ceiling: s.ceiling,
      }))
      .filter((s) => s.declared !== s.spends)
      .map(
        (s) => `${s.bucket}: declared ${s.declared}, spends ${s.ceiling} (${s.spends}) — ${s.file}`,
      );
    expect(
      mismatched,
      "a bucket's declared family and the ceiling constant its route passes " +
        "disagree; the map is a claim about which ceiling applies, so the call " +
        "site wins and the map is what has to change",
    ).toEqual([]);
  });

  it("never spends a read family's ceiling from a write handler, or the reverse", () => {
    // The second half, and the one that catches the mislabelling BEFORE the
    // ceiling constant is chosen to match it. `route-local` is exempt by
    // construction — it is a mechanism, not a direction, and it held both GET and
    // POST buckets for as long as it held any.
    const wrongDirection = sites
      .filter((s) => {
        const family = API_V1_IP_BUCKET_FAMILIES[s.bucket];
        if (!family || family === "route-local") return false;
        return s.method === "GET"
          ? WRITE_FAMILIES.includes(family)
          : READ_FAMILIES.includes(family);
      })
      .map(
        (s) => `${s.bucket}: ${s.method} handler declared ${API_V1_IP_BUCKET_FAMILIES[s.bucket]}`,
      );
    expect(
      wrongDirection,
      "a write handler wearing a read family's ceiling runs at five times its " +
        "intended limit and reads as deliberate in the map — the family must " +
        "match the direction of the handler that spends it",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A11-2 — the SAME assignment check, for the PER-USER half
// ---------------------------------------------------------------------------
//
// Everything above collects and files only the buckets keyed on `callerIp(`.
// `lib/infra/api-v1-limits.ts:100-101`'s own canon rule — "a route in the
// `authenticated-read` family spends both budgets or it is not in the family"
// — has a per-user half nothing here asserted, and that is the exact mechanism
// A11-1 used: `adoptions/[petToken]/route.ts` imported the per-IP constant,
// spent it, filed cleanly under `authenticated-read` in every assertion above,
// and the per-user counter its OWN docblock said it shared with the catalogue
// route went unspent — any signed-in account could loop the ficha at 600/min
// from one IP with no per-account ceiling at all.
//
// A family-level check, which is what this section adds, would NOT have
// caught that specific tree on its own: `adoptions/route.ts` already spent
// `API_V1_AUTHENTICATED_READ_USER_LIMIT`, so `authenticated-read` was never
// silent as a FAMILY. It still earns its place — a family whose per-user
// anchor constant is declared and spent by NO route at all is either dead code
// or a rule enforced somewhere this file cannot see, and that is the same
// "declares vs. spends" gap `ipBucketsIn`/`collectIpBucketSites` closes for
// the per-IP half, one level up.

/**
 * Which family a shared PER-USER ceiling constant belongs to. Keyed by
 * IDENTIFIER, for the same reason `FAMILY_OF_SHARED_CEILING` is: the
 * identifier is the only thing a call site can be trusted to say, and this
 * table names constants it does not import so it proves something about the
 * TEXT a route passes rather than about a value already known to be right.
 */
const FAMILY_OF_USER_CEILING: Readonly<Record<string, ApiV1IpFamily>> = {
  API_V1_ACCOUNT_SECURITY_USER_LIMIT: "account-security",
  API_V1_AUTHENTICATED_READ_USER_LIMIT: "authenticated-read",
  API_V1_AUTHENTICATED_WRITE_USER_LIMIT: "authenticated-write",
  API_V1_INBOX_STATE_USER_LIMIT: "inbox-state",
  API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT: "pet-disclosure-write",
  API_V1_PET_RECORD_WRITE_USER_LIMIT: "pet-record-write",
  API_V1_PET_REGISTRATION_USER_LIMIT: "pet-registration",
  API_V1_MEDIA_UPLOAD_USER_LIMIT: "media-upload",
};

/**
 * Families whose per-user half is DELIBERATELY not a route-level call site —
 * each decision already documented at the place that owns it, restated here
 * so this file does not have to guess at an absence:
 *
 *   - `account-security` USED TO BE HERE and left with D4
 *     (`POST /me/reactivate`), which spends `API_V1_ACCOUNT_SECURITY_USER_LIMIT`
 *     at the route — so the family is now SEEN spent and the non-vacuity check
 *     below would call the entry stale. `revoke-sessions` still spends its
 *     per-user pair inside `revokeAllSessions` (`REVOKE_SESSIONS_USER_BUCKET`),
 *     with the same numbers; the two are one anchor held in two places, pinned
 *     equal by "keeps account-security's two per-user anchors identical" below.
 *   - `adoption-application` — `adoptions/[petToken]/route.ts`'s own
 *     docblock: the per-user anchor is spent INSIDE
 *     `submitAdoptionApplication` (`ADOPTION_APPLICATION_USER_LIMIT`,
 *     `src/modules/adoption/application/adoption-application-limits.ts:131`),
 *     so the web form and this endpoint share ONE counter instead of two.
 *   - `public-reference` — `/api/v1/localities` is one of the surface's five
 *     `@no-auth-required` routes; there is no live user to key a per-user
 *     bucket on.
 */
const USER_HALF_IN_USE_CASE_LAYER: ReadonlySet<ApiV1IpFamily> = new Set([
  "adoption-application",
  "public-reference",
]);

/**
 * Collects per-user limiter call sites the same way `collectIpBucketSites`
 * collects per-IP ones — the same stricter three-argument shape — keeping the
 * ones `keyedOn` does NOT start with `callerIp(` instead of the ones that do.
 */
function collectUserBucketSites(): IpBucketSite[] {
  const call =
    /"(api_v1_[a-z0-9_]+)"\s*,\s*(callerIp\([^)]*\)|[A-Za-z0-9_.]+)\s*,\s*([A-Za-z0-9_.]+)\s*[,)]/gs;
  const handler = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

  const sites: IpBucketSite[] = [];
  for (const file of globSync(ROUTE_GLOB)) {
    const source = readFileSync(file, "utf8");
    const handlers = [...source.matchAll(handler)].map((m) => ({
      at: m.index ?? 0,
      method: m[1],
    }));

    for (const match of source.matchAll(call)) {
      const [, bucket, keyedOn, ceiling] = match;
      if (keyedOn.startsWith("callerIp(")) continue; // per-IP bucket, not ours
      const at = match.index ?? 0;
      const enclosing = handlers.filter((h) => h.at < at).at(-1) ?? null;
      sites.push({
        bucket,
        file: file.replaceAll("\\", "/"),
        ceiling,
        method: enclosing?.method ?? null,
      });
    }
  }
  return sites;
}

/**
 * NON-VACUITY FLOOR, the per-user twin of `MIN_IP_BUCKETS`. Recounted from
 * `collectUserBucketSites()` on this tree, not incremented — the paragraph on
 * `MIN_IP_BUCKETS` above has the full argument for why an incremented floor
 * eventually lies.
 *
 * 38 → 44 with the dispute door (D6, 2026-09-25), and the jump is not six new
 * buckets: it is ONE (`api_v1_me_pet_claims_evidence_user`, the ticket's media
 * anchor) on a tree that had already grown to 43 call sites while the floor sat
 * at 38. RECOUNTED by running `collectUserBucketSites()`'s own regex over
 * `app/api/v1/**\/route.ts` on this worktree — 43 before the change, 44 after —
 * not obtained by adding one to 38, which would have left the floor five below
 * the surface and the non-vacuity check correspondingly blunter.
 *
 * 44 → 45 with the reactivation door (D4): `api_v1_me_reactivate_user`.
 * RECOUNTED with `collectUserBucketSites()`'s regex on this worktree, 45.
 *
 * 45 → 47 with the mis denuncias door (M16): `api_v1_me_welfare_reports_read_user`
 * and `api_v1_me_welfare_report_detail_user`. RECOUNTED with the same regex, 47.
 */
const MIN_USER_BUCKETS = 47;

describe("/api/v1 per-user rate-limit buckets — every call site maps to a declared family", () => {
  const sites = collectUserBucketSites();

  it("finds enough call sites that an equality assertion means something", () => {
    expect(sites.length).toBeGreaterThanOrEqual(MIN_USER_BUCKETS);
  });

  it("resolves a family for every per-user ceiling a route actually spends", () => {
    const unmapped = sites
      .filter((s) => !(s.ceiling in FAMILY_OF_USER_CEILING))
      .map((s) => `${s.bucket}: ${s.ceiling} (${s.file})`);
    expect(
      unmapped,
      "a per-user bucket spending a ceiling this file does not recognise is a " +
        "new anchor constant nobody taught this fence about — add it to " +
        "FAMILY_OF_USER_CEILING",
    ).toEqual([]);
  });

  it("spends every user-capable family's ceiling from at least one route, unless the family says why not", () => {
    const spentFamilies = new Set(
      sites
        .map((s) => FAMILY_OF_USER_CEILING[s.ceiling])
        .filter((f): f is ApiV1IpFamily => f !== undefined),
    );
    const userCapableFamilies = [...new Set(Object.values(FAMILY_OF_USER_CEILING))];
    const silent = userCapableFamilies.filter(
      (family) => !spentFamilies.has(family) && !USER_HALF_IN_USE_CASE_LAYER.has(family),
    );
    expect(
      silent,
      "a family with a declared per-user ceiling constant that no route call " +
        "site spends is either dead code or a rule enforced where this file " +
        "cannot see it — name it in USER_HALF_IN_USE_CASE_LAYER with why, or " +
        "wire the call site",
    ).toEqual([]);
  });

  it("keeps the use-case allowlist an absence, not an escape hatch", () => {
    // NON-VACUITY for the allowlist itself: a family added to
    // USER_HALF_IN_USE_CASE_LAYER that a route call site ALSO spends would
    // silently stop being checked by the assertion above — a family belongs on
    // the list only for as long as NOTHING here sees it spent.
    const wronglyAllowlisted = [...USER_HALF_IN_USE_CASE_LAYER].filter((family) =>
      sites.some((s) => FAMILY_OF_USER_CEILING[s.ceiling] === family),
    );
    expect(
      wronglyAllowlisted,
      "this family is both allowlisted as use-case-only AND spent by a route " +
        "call site this file can see — the route-level spend makes the " +
        "allowlist entry stale; remove it",
    ).toEqual([]);
  });
});

describe("/api/v1 rate-limit families — the numbers the derivation committed to", () => {
  it("keeps the authenticated write IP ceiling at 12× its per-user anchor", () => {
    // This is the load-bearing relationship in the write family: the IP ceiling
    // exists to stay far enough above the per-user one that the USER bucket is
    // the binding constraint for any plausible number of simultaneous legitimate
    // writers behind one carrier gateway. At the old 20/min, TWO people at their
    // own ceiling exhausted the gateway — the wrong bucket doing the refusing.
    expect(API_V1_AUTHENTICATED_WRITE_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_AUTHENTICATED_WRITE_USER_LIMIT.maxPerMinute ?? 0) * 12,
    );
  });

  it("keeps the hourly write ceiling at THIRTY of its per-user anchor, not twelve", () => {
    // THE HALF NOBODY PINNED, and the docblock on the constant asserted the
    // wrong number for it until 2026-08-26 — "12× the per-user ceiling", flat,
    // when 1,200/hr is 30 × 40/hr and only the per-minute side is 12×.
    //
    // Pinned SEPARATELY and with the multiple spelled out, because the corrected
    // prose creates its own hazard: a reader who now sees two different factors
    // may read them as an inconsistency to tidy and "fix" 1,200 down to 480.
    // They differ on purpose. The per-user pair is 10/min and 40/hr — an hourly
    // cap deliberately far below a sustained per-minute rate — so carrying 12×
    // onto both windows would propagate that narrowing into the IP ceiling and
    // make the IP bucket the binding one again in the hour, which is the exact
    // inversion this family was re-derived to remove.
    expect(API_V1_AUTHENTICATED_WRITE_IP_LIMIT.maxPerHour).toBe(
      (API_V1_AUTHENTICATED_WRITE_USER_LIMIT.maxPerHour ?? 0) * 30,
    );
  });

  it("keeps account-security flat at 12× on BOTH windows", () => {
    // The contrast that makes the line above readable rather than arbitrary:
    // this family's per-user pair (5/min, 20/hr) is already proportionate, so
    // 12× preserves it on both windows — 60 and 240. Asserted so "the write
    // family's rule" in its docblock cannot silently become a third multiple.
    expect(API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerMinute).toBe(60);
    expect(API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerHour).toBe(240);
    // D4 gave the family a per-user constant at the route, so the 12× is now a
    // relationship this file can hold rather than only two literals.
    expect(API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_ACCOUNT_SECURITY_USER_LIMIT.maxPerMinute ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerHour).toBe(
      (API_V1_ACCOUNT_SECURITY_USER_LIMIT.maxPerHour ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps account-security's two per-user anchors identical", async () => {
    // One family, one anchor, held in two places: the route-level constant
    // `/me/reactivate` spends and the use-case-level one `revokeAllSessions`
    // spends. If they drift, the 12× above is true of one member and false of
    // the other, and nothing else would say so.
    const { REVOKE_SESSIONS_USER_LIMIT } = await import(
      "@/src/modules/auth/application/revoke-sessions"
    );
    expect(API_V1_ACCOUNT_SECURITY_USER_LIMIT).toEqual(REVOKE_SESSIONS_USER_LIMIT);
  });

  it("keeps account-security an order of magnitude below the read family", () => {
    // The half of `/me/revoke-sessions`'s original argument that survived: the
    // act really is rare. If this ever inverts, the family stopped meaning what
    // its docblock says it means.
    expect(API_V1_ACCOUNT_SECURITY_IP_LIMIT.maxPerMinute ?? 0).toBeLessThan(
      (API_V1_AUTHENTICATED_READ_IP_LIMIT.maxPerMinute ?? 0) / 5,
    );
  });

  it("gives the public reference read the same ceiling as an authenticated one", () => {
    // Not a coincidence to be tidied away later: `/api/v1/localities` has no
    // identity to fall back on, so its per-IP bucket is the ONLY bucket it has.
    // Tightening it below the authenticated family would put the strictest limit
    // on the surface with the weakest instrument.
    expect(API_V1_PUBLIC_REFERENCE_IP_LIMIT).toEqual(API_V1_AUTHENTICATED_READ_IP_LIMIT);
  });

  it("computes the CGNAT-family per-IP aggregate rather than asserting it in prose", () => {
    // Buckets are separate on purpose, so a per-IP ceiling is ADDITIVE across
    // them and the honest figure is the sum. §1.1 of api-invariants.md records
    // what happened when this number lived only in prose: an hourly figure was
    // transplanted into the per-minute slot and overstated the ceiling by 2.2×
    // in the paragraph that existed to state it honestly.
    //
    // THE TERMS USED TO BE TRANSCRIBED HERE ("5 × 600 … + 1 × 60 = 3.300/min")
    // and WU-Q-1 made them wrong: two buckets landed, the sum moved to 4.140,
    // and the arithmetic in this comment described a surface that no longer
    // existed. A comment that enumerates a set is a second copy of the set. The
    // list that cannot lie is `API_V1_IP_BUCKET_FAMILIES` next to the ceiling
    // constants; what stays here is the PIN, which is the only part a test can
    // hold. `route-local` is empty, so the sum is now the whole surface.
    //
    // 8.124 → 8.844 with the editar door (`pets/{token}/profile`), which adds
    // one authenticated-read bucket (600/min) and one authenticated-write
    // bucket (120/min). MOVING THIS NUMBER IS PART OF ADDING A ROUTE and the
    // paragraph above is why it is deliberately a hand-edited pin: the sum is
    // computed, so an unexplained rise here is a bucket somebody added without
    // deciding what its ceiling should be.
    //
    // 8.844 → 9.504 with the privacidad door (`me/privacy`, WU-R), which adds
    // one authenticated-read bucket (600/min, the art. 14 export) and one
    // ACCOUNT-SECURITY bucket (60/min, the art. 16 supresión) — the second
    // member that family has ever had, and the cheapest thing added to this sum
    // since it started being computed. That asymmetry is the derivation showing
    // through rather than a rounding: the read is a read like any other, and the
    // write is `revoke-sessions`'s kind of act, which is rare by construction.
    //
    // 9.504 → 10.224 with the "editar mis datos" door (`me/profile`, WU-R), one
    // authenticated-read bucket (600/min) and one authenticated-write bucket
    // (120/min) — the same pair, and the same two families, the pet's own editar
    // door added. That the account form and the animal form land on identical
    // ceilings is the derivation agreeing with itself: both are one person in a
    // form correcting a value they own.
    //
    // 10.224 → 10.944 with the turnos door (`me/appointments`, WU-S), one
    // authenticated-read bucket (600/min) and one authenticated-write bucket
    // (120/min) — the third door in a row to add exactly that pair.
    //
    // RE-DERIVED FROM THE MAP, NOT FROM THE PREVIOUS PIN, because "10.224 + 720"
    // is the reasoning that produced this lane's own rejection: the two buckets
    // existed in the routes and were never added to `API_V1_IP_BUCKET_FAMILIES`,
    // so the reduce never saw them, the sum never moved, and a pin adjusted to
    // whatever made the file green would have recorded a ceiling 720/min BELOW
    // what one address may actually spend. A pin that is fitted to the code it
    // is meant to constrain is not a pin. So the terms are counted out of the
    // map on this tree, once, and the two derivations are checked against each
    // other:
    //
    //   authenticated-read     14 × 600 = 8.400
    //   authenticated-write     6 × 120 =   720
    //   account-security        2 ×  60 =   120
    //   public-reference        1 × 600 =   600
    //   inbox-state             1 × 240 =   240
    //   pet-disclosure-write    2 × 180 =   360
    //   pet-record-write        1 × 240 =   240
    //   pet-registration        1 × 120 =   120
    //   media-upload            1 × 144 =   144
    //                          ── 29 buckets ─────────
    //                                     10.944
    //
    // and 10.224 + 600 + 120 = 10.944 agrees. Both had to, and the point of
    // doing both is that only the FIRST would have caught the missing entries.
    //
    // 10.944 → 11.064 at the 2026-08-30 integration merge, with the reclamar
    // door (`me/pet-claims`, WU-V): ONE authenticated-write bucket, 120/min. It
    // is the first door in five to add a single bucket rather than a read/write
    // pair, because its two commands (`lookup`, `claim_free`) share one POST
    // route AND one per-user budget on purpose — splitting the per-IP counter
    // would hand a prober back at the gateway what the shared user budget
    // refuses.
    //
    // THE MAP ENTRY WAS ADDED BY THE INTEGRATOR, NOT BY THE LANE, and that is
    // the reason this paragraph exists rather than being a line in a merge
    // commit. `lib/infra/api-v1-limits.ts` belonged to a parallel lane in that
    // window, so the route landed spending a bucket the map did not name — the
    // turnos rejection's exact shape, one window later, with the difference that
    // this time the lane SAID SO in its handover instead of it being found by a
    // reviewer. While the entry was missing the reduce did not see the bucket
    // and this ceiling under-declared itself by 120/min.
    //
    // 11.064 → 12.324 with the adopción doors (`adoptions`,
    // `adoptions/{petToken}`, `me/adoption-applications`; WU-U). THREE buckets
    // for three routes, and the first door on this surface to break the
    // one-read-one-write pattern the ones above it all followed: the catalogue
    // and the ficha SHARE one authenticated-read bucket (600/min) because
    // tapping a card is what a person does from the list, "mis postulaciones"
    // has its own (600/min), and the apply is the first and only member of a new
    // family, `adoption-application`, at 60/min — the cheapest write ceiling on
    // the surface, for an act whose cost is a shelter's attention rather than
    // ours.
    //
    // RE-DERIVED FROM THE MAP, and this door is the second lane in a row whose
    // rejection was exactly the failure that reasoning prevents. Its three
    // buckets were spent by the routes and were never added to
    // `API_V1_IP_BUCKET_FAMILIES`, so the reduce never saw them and this pin,
    // adjusted to whatever made the file green, would have recorded a ceiling
    // 1.260/min BELOW what one address may actually spend.
    //
    // THE LANE'S OWN FIGURE WAS 12.204 AND IT IS NOT THE ONE PINNED HERE. That
    // number is correct for the tree the lane held — no reclamar door — and it is
    // the very "12.204 from a third lane" the paragraph above records as the
    // arithmetic that would have been wrong. The reclamar door landed while this
    // work was open, so the merged tree carries its 120/min too. This is the
    // case the whole comment argues for, arriving twice in three windows:
    // 10.944 + 600 + 600 + 60 = 12.204 is right about the wrong tree.
    //
    // Counted out of the merged map, once, and checked both ways again:
    //
    //   authenticated-read     16 × 600 = 9.600
    //   authenticated-write     7 × 120 =   840
    //   account-security        2 ×  60 =   120
    //   public-reference        1 × 600 =   600
    //   inbox-state             1 × 240 =   240
    //   pet-disclosure-write    2 × 180 =   360
    //   pet-record-write        1 × 240 =   240
    //   pet-registration        1 × 120 =   120
    //   media-upload            1 × 144 =   144
    //   adoption-application    1 ×  60 =    60
    //                          ── 33 buckets ─────────
    //                                     12.324
    //
    // and 11.064 + 600 + 600 + 60 = 12.324 agrees. Both had to, and the point of
    // doing both is that only the FIRST would have caught the missing entries.
    //
    // Every enumeration above is the thing this comment warns about three
    // paragraphs up — a second copy of a set — so they are dated rather than
    // maintained: each is what the map held on the day its door landed, kept
    // because the arithmetic is the evidence for the pin. `API_V1_IP_BUCKET_
    // FAMILIES` is still the list that cannot lie; recount it, do not trust
    // these tables.
    //
    // RE-DERIVED 2026-08-30 for the denuncia door (WU-T), which adds ONE
    // `authenticated-write` bucket, `api_v1_welfare_reports_ip`. Hand-summed per
    // family over the merged map rather than read off the `reduce` this line
    // compares against, because a computed value agreeing with itself is not
    // evidence:
    //
    //   authenticated-read    16 × 600 = 9.600
    //   authenticated-write    8 × 120 =   960
    //   account-security       2 ×  60 =   120
    //   inbox-state            1 × 240 =   240
    //   public-reference       1 × 600 =   600
    //   pet-disclosure-write   2 × 180 =   360
    //   pet-record-write       1 × 240 =   240
    //   pet-registration       1 × 120 =   120
    //   media-upload           1 × 144 =   144
    //   adoption-application   1 ×  60 =    60
    //                          ── 34 buckets ─────────
    //                                     12.444
    //
    // and 12.324 + 120 = 12.444 agrees. THIS PIN GOES RED WHEN THE BUCKET
    // LANDS, and the lane that handed this entry to an integrator said twice
    // that it stayed green. It is worth naming because the mistake is easy: the
    // OTHER two assertions in this file really do go from red to green with the
    // entry, so "adding the line fixes the fence" is half true and this third
    // one moves the opposite way — the aggregate is a sum over the map, so
    // growing the map grows the sum.
    //
    // 12.324 → 12.924 with the BUSCAR half of turnos, and the delta is ONE
    // `authenticated-read` bucket at 600/min — `api_v1_appointment_search_ip`,
    // shared by the two search routes. Hand-summed per family on this worktree
    // rather than read off the `reduce` the assertion compares against, because a
    // computed value agreeing with itself is not evidence:
    //
    //   authenticated-read     17 × 600 = 10.200
    //   authenticated-write     7 × 120 =    840
    //   account-security        2 ×  60 =    120
    //   inbox-state             1 × 240 =    240
    //   public-reference        1 × 600 =    600
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 34 buckets ─────────
    //                                     12.924
    //
    // and 12.324 + 600 = 12.924 agrees. Both had to.
    //
    // 13.044 AT THE 2026-08-30 INTEGRATION MERGE, and the two paragraphs above
    // are BOTH stale the moment they are read — which is the first time on this
    // constant that two doors landed in the same window and each hand-summed a
    // tree the other was about to invalidate. WU-T added one
    // `authenticated-write` (12.444, and its comment says "this pin goes red
    // when the bucket lands"); WU-S added one `authenticated-read` (12.924).
    // Neither number survives the merge. Hand-summed once more over the MERGED
    // map, not off the `reduce` and not by adding the two deltas:
    //
    //   authenticated-read     17 × 600 = 10.200
    //   authenticated-write     8 × 120 =    960
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 35 buckets ─────────
    //                                     13.044
    //
    // and 12.324 + 120 + 600 = 13.044 agrees. The agreement is worth one line
    // ONLY because it is the pair of deltas that agrees, not either lane's
    // figure: 12.444 + 600 and 12.924 + 120 both also give 13.044, while
    // 12.444 and 12.924 on their own are each wrong by the other lane's bucket.
    // A pin that is only ever incremented is right until two doors land at
    // once, and then it is wrong in whichever direction the merge order fell.
    //
    // 13.164 WITH THE MUDANZA DOOR (WU-P, `pets/{token}/move`): one more
    // `authenticated-write` bucket, `api_v1_move_write_ip`. Hand-summed per
    // family over the map as this lane leaves it, and NOT read off the `reduce`
    // this assertion compares against — a computed value agreeing with itself is
    // not evidence:
    //
    //   authenticated-read     17 × 600 = 10.200
    //   authenticated-write     9 × 120 =  1.080
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 36 buckets ─────────
    //                                     13.164
    //
    // and 13.044 + 120 = 13.164 agrees.
    //
    // 13.884 WITH THE DEVOLUCIÓN DOOR (WU-P, `pets/{token}/return`), which is
    // GET+POST and so contributes TWO buckets — one `authenticated-read` (600)
    // and one `authenticated-write` (120). Hand-summed per family over the map
    // as this lane leaves it, and NOT read off the `reduce` this assertion
    // compares against, because a computed value agreeing with itself is not
    // evidence:
    //
    //   authenticated-read     18 × 600 = 10.800
    //   authenticated-write    10 × 120 =  1.200
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 38 buckets ─────────
    //                                     13.884
    //
    // and 13.164 + 600 + 120 = 13.884 agrees. WHOEVER MERGES THIS ALONGSIDE
    // ANOTHER LANE MUST RE-SUM RATHER THAN ADD 720: this figure is right for a
    // tree carrying this lane's two doors and no others, which is precisely the
    // assumption the paragraphs above record going wrong twice.
    //
    // 14.004 WITH THE NATIVE IDENTITY DOOR (`POST /me/identity`, PO 2026-09-05),
    // which is POST-only and so contributes exactly ONE `authenticated-write`
    // bucket (120). Hand-summed per family over the map as this lane leaves it,
    // and NOT read off the `reduce` this assertion compares against — a computed
    // value agreeing with itself is not evidence:
    //
    //   authenticated-read     18 × 600 = 10.800
    //   authenticated-write    11 × 120 =  1.320
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 39 buckets ─────────
    //                                     14.004
    //
    // and 13.884 + 120 = 14.004 agrees.
    //
    // 14.124 WITH THE VACCINE-REMINDER DOOR (`pets/{token}/reminders`), which
    // is POST-only and so contributes exactly ONE `authenticated-write` bucket
    // (120) — the same shape `move` and `me/identity` each added. Hand-summed
    // per family over the map as this lane leaves it, and NOT read off the
    // `reduce` this assertion compares against — a computed value agreeing
    // with itself is not evidence:
    //
    //   authenticated-read     18 × 600 = 10.800
    //   authenticated-write    12 × 120 =  1.440
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 40 buckets ─────────
    //                                     14.124
    //
    // and 14.004 + 120 = 14.124 agrees.
    //
    // 14.844 WITH THE ACOMPAÑAMIENTO DE ADOPCIÓN DOOR (`pets/{token}/rehome`),
    // which is GET+POST and so contributes TWO buckets — one
    // `authenticated-read` (600) and one `authenticated-write` (120), the same
    // shape `return` added. Hand-summed per family over the map as this lane
    // leaves it, and NOT read off the `reduce` this assertion compares against
    // — a computed value agreeing with itself is not evidence:
    //
    //   authenticated-read     19 × 600 = 11.400
    //   authenticated-write    13 × 120 =  1.560
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 42 buckets ─────────
    //                                     14.844
    //
    // and 14.124 + 600 + 120 = 14.844 agrees.
    //
    // 14.964 WITH THE PUSH-TARGET DOOR (`me/push-targets`), and this one breaks
    // the pattern above in a way worth reading rather than skimming: it is POST
    // ONLY, so it contributes ONE bucket and not the read/write pair the last
    // four doors each added. There is no GET because there is nothing for a
    // phone to read — it already knows its own device id and its own token, and
    // an endpoint that listed somebody's registered devices would be a new
    // disclosure surface built for no caller.
    //
    // The single bucket is `authenticated-write` by borrowing rather than by a
    // family of its own; `lib/infra/api-v1-limits.ts` argues that at the entry.
    // Hand-summed per family over the map as this lane leaves it, and NOT read
    // off the `reduce` this assertion compares against:
    //
    //   authenticated-read     19 × 600 = 11.400
    //   authenticated-write    14 × 120 =  1.680
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 43 buckets ─────────
    //                                     14.964
    //
    // and 14.844 + 120 = 14.964 agrees.
    //
    // 15.684 WITH THE FOSTER DOOR (`me/foster`, T4-M5), GET+POST and so two
    // buckets again — the read/write pair, not the single bucket the push-target
    // door contributed. Neither borrows a family of its own: reading who is
    // fostering the caller's animals is an ordinary authenticated read, and the
    // write offers or ends a foster stay, which moves who physically holds the
    // animal — exactly the act `authenticated-write` is anchored on.
    // Hand-summed per family over the map as this lane leaves it, and NOT read
    // off the `reduce` this assertion compares against:
    //
    //   authenticated-read     20 × 600 = 12.000
    //   authenticated-write    15 × 120 =  1.800
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 45 buckets ─────────
    //                                     15.684
    //
    // and 14.964 + 600 + 120 = 15.684 agrees.
    //
    // 16.884 WITH THE CASOS DOOR (`me/cases` and `me/cases/{publicCode}`, M11).
    // Two routes, both GET-only, so two READ buckets and no write: the owner's
    // case list and one case detail are ordinary authenticated reads of what the
    // web already shows them. Hand-summed per family over the map as this lane
    // leaves it, and NOT read off the `reduce` this assertion compares against:
    //
    //   authenticated-read     22 × 600 = 13.200
    //   authenticated-write    15 × 120 =  1.800
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 47 buckets ─────────
    //                                     16.884
    //
    // and 15.684 + 2 × 600 = 16.884 agrees.
    //
    // 17.484 WITH THE POSTER DOOR TOO (`pets/{token}/poster`, M13): GET only,
    // one bucket, in `authenticated-read` — a read of the animal the lost
    // cockpit just loaded. M11 and M13 landed in the same integration batch, so
    // the family becomes 23 × 600 = 13.800, 48 buckets, and
    // 16.884 + 600 = 17.484.
    //
    // 17.604 WITH THE MAP DOOR TOO (`geocoding`, M17): POST only, one bucket, in
    // `authenticated-write` — a POST, like the welfare door's resolve_location.
    // 16 × 120 = 1.920 for that family, 49 buckets, and 17.484 + 120 = 17.604.
    //
    // 17.604 UNCHANGED WITH THE DISPUTE DOOR (D6, 2026-09-25), and that is the
    // entry worth reading here, because a door landed and this pin did NOT move.
    // `command: "dispute"` and `command: "request_evidence_ticket"` ride the
    // EXISTING `me/pet-claims` POST and spend its existing per-IP bucket,
    // `api_v1_me_pet_claims_ip` (`authenticated-write`) — one per-IP counter for
    // every claim command, so alternating between them buys a prober nothing.
    // The one bucket D6 adds is PER-USER (`api_v1_me_pet_claims_evidence_user`,
    // `API_V1_MEDIA_UPLOAD_USER_LIMIT`), which this sum does not see and must
    // not: it is keyed on an account, not on a carrier gateway. Hand-summed per
    // family over the map as this lane leaves it, and NOT read off the `reduce`
    // this assertion compares against:
    //
    //   authenticated-read     23 × 600 = 13.800
    //   authenticated-write    16 × 120 =  1.920
    //   account-security        2 ×  60 =    120
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 49 buckets ─────────
    //                                     17.604
    //
    // and 17.604 + 0 = 17.604 agrees. The per-user half is counted where it
    // lives: `MIN_USER_BUCKETS`, 43 → 44 call sites on this tree.
    //
    // 17.664 WITH THE REACTIVATION DOOR (D4, `POST /me/reactivate`): POST only,
    // one bucket, `api_v1_me_reactivate_ip`, in `account-security` — the
    // family's third member after `revoke-sessions` and the `me/privacy`
    // write, and the same act in every respect it was derived for: rare,
    // deliberate, on your own account. Its per-user bucket
    // (`api_v1_me_reactivate_user`) is keyed on an account and is not in this
    // sum. Hand-summed per family over the map as this lane leaves it, and NOT
    // read off the `reduce` this assertion compares against:
    //
    //   authenticated-read     23 × 600 = 13.800
    //   authenticated-write    16 × 120 =  1.920
    //   account-security        3 ×  60 =    180
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 50 buckets ─────────
    //                                     17.664
    //
    // and 17.604 + 60 = 17.664 agrees.
    //
    // 18.864 WITH THE MIS DENUNCIAS DOOR (`me/welfare-reports` and
    // `me/welfare-reports/{referenceCode}`, M16). Two routes, both GET-only, so
    // two READ buckets and no write — the same shape the casos door added: the
    // author's list and one denuncia are ordinary authenticated reads of what
    // `/denuncias/mias` already shows them. Hand-summed per family over the map
    // as this lane leaves it, and NOT read off the `reduce` this assertion
    // compares against:
    //
    //   authenticated-read     25 × 600 = 15.000
    //   authenticated-write    16 × 120 =  1.920
    //   account-security        3 ×  60 =    180
    //   public-reference        1 × 600 =    600
    //   inbox-state             1 × 240 =    240
    //   pet-disclosure-write    2 × 180 =    360
    //   pet-record-write        1 × 240 =    240
    //   pet-registration        1 × 120 =    120
    //   media-upload            1 × 144 =    144
    //   adoption-application    1 ×  60 =     60
    //                          ── 52 buckets ─────────
    //                                     18.864
    //
    // and 17.664 + 2 × 600 = 18.864 agrees.
    expect(API_V1_CGNAT_FAMILY_IP_CEILING_PER_MINUTE).toBe(18_864);
  });

  it("keeps pet-disclosure-write at N callers on BOTH windows", () => {
    // Two routes, one anchor: `POST /pets/{token}/shares` and
    // `POST /pets/{token}/lost` carried identical per-user ceilings in two files
    // before they moved here, which is why they share one IP ceiling and why the
    // relationship rather than the digits is what this pins.
    expect(API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT.maxPerMinute ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT.maxPerHour).toBe(
      (API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT.maxPerHour ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps pet-record-write at N callers on BOTH windows", () => {
    expect(API_V1_PET_RECORD_WRITE_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_PET_RECORD_WRITE_USER_LIMIT.maxPerMinute ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_PET_RECORD_WRITE_IP_LIMIT.maxPerHour).toBe(
      (API_V1_PET_RECORD_WRITE_USER_LIMIT.maxPerHour ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps pet-registration at N callers on BOTH windows", () => {
    expect(API_V1_PET_REGISTRATION_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_PET_REGISTRATION_USER_LIMIT.maxPerMinute ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_PET_REGISTRATION_IP_LIMIT.maxPerHour).toBe(
      (API_V1_PET_REGISTRATION_USER_LIMIT.maxPerHour ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps media-upload at N callers on BOTH windows", () => {
    expect(API_V1_MEDIA_UPLOAD_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerMinute ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
    expect(API_V1_MEDIA_UPLOAD_IP_LIMIT.maxPerHour).toBe(
      (API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerHour ?? 0) * API_V1_SIMULTANEOUS_CALLERS,
    );
  });

  it("keeps the media-upload per-user anchor the tightest write on the surface", () => {
    // NOT a taste check. The two requests behind one photo authorise ≈15 MB of
    // object-store traffic and a CPU-bound re-encode, so this anchor must stay
    // BELOW the ones that bound a row append — and the direction is the thing
    // worth pinning, because the number is the part somebody will want to raise
    // when an upload feels slow. Raising it past an asiento's ceiling is a
    // decision that has to walk past this line on purpose.
    const perMinute = API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerMinute ?? 0;
    expect(perMinute).toBeGreaterThan(0);
    expect(perMinute).toBeLessThan(API_V1_PET_RECORD_WRITE_USER_LIMIT.maxPerMinute ?? 0);
    expect(API_V1_MEDIA_UPLOAD_USER_LIMIT.maxPerHour ?? 0).toBeLessThan(
      API_V1_PET_RECORD_WRITE_USER_LIMIT.maxPerHour ?? 0,
    );
  });

  it("keeps every per-user anchor above zero, so the products mean something", () => {
    // THE NON-VACUITY FLOOR FOR THE SIX ASSERTIONS ABOVE, and the one
    // `api-v1-auth-routes.test.ts` had to add for the same reason: `0 === 0 * 12`
    // is true, so an anchor silently zeroed would satisfy every relationship in
    // this describe block while the ceiling it describes collapsed. These are the
    // buckets that bound a PERSON; a change to one of them has to walk past this
    // line on purpose.
    const anchors = [
      API_V1_PET_DISCLOSURE_WRITE_USER_LIMIT,
      API_V1_PET_RECORD_WRITE_USER_LIMIT,
      API_V1_PET_REGISTRATION_USER_LIMIT,
      API_V1_MEDIA_UPLOAD_USER_LIMIT,
    ];
    for (const anchor of anchors) {
      expect(anchor.maxPerMinute ?? 0).toBeGreaterThan(0);
      expect(anchor.maxPerHour ?? 0).toBeGreaterThan(0);
    }
    expect(API_V1_SIMULTANEOUS_CALLERS).toBe(12);
  });

  it("never lets a write family's IP ceiling reach the read family's", () => {
    // The three families that landed on 2026-08-27 are the widest writes on the
    // surface, and `pet-record-write` in particular sits at the same per-minute
    // figure as `inbox-state`. None of them may drift up to a READ ceiling: a
    // write costs more per request than a read on every one of these routes, and
    // the moment a write bucket admits as much traffic as the read family the
    // ordering argument in api-v1-limits.ts stops being true.
    const readCeiling = API_V1_AUTHENTICATED_READ_IP_LIMIT.maxPerMinute ?? 0;
    for (const write of [
      API_V1_AUTHENTICATED_WRITE_IP_LIMIT,
      API_V1_PET_DISCLOSURE_WRITE_IP_LIMIT,
      API_V1_PET_RECORD_WRITE_IP_LIMIT,
      API_V1_PET_REGISTRATION_IP_LIMIT,
    ]) {
      expect(write.maxPerMinute ?? 0).toBeLessThan(readCeiling);
    }
  });

  it("keeps inbox-state flat at 12× on BOTH windows, like account-security", () => {
    // The new family's own relationship, pinned for the reason the two above are:
    // its per-user pair (20/min, 200/hr) is already proportionate, so 12× carries
    // onto both windows without propagating a deliberate narrowing.
    expect(API_V1_INBOX_STATE_IP_LIMIT.maxPerMinute).toBe(
      (API_V1_INBOX_STATE_USER_LIMIT.maxPerMinute ?? 0) * 12,
    );
    expect(API_V1_INBOX_STATE_IP_LIMIT.maxPerHour).toBe(
      (API_V1_INBOX_STATE_USER_LIMIT.maxPerHour ?? 0) * 12,
    );
  });

  it("lets a person clear an inbox faster than they can hand over an animal", () => {
    // THE REASON THIS FAMILY EXISTS AT ALL, as an assertion rather than a
    // paragraph. If the inbox ceiling ever falls to the authenticated-write
    // family's, the eleventh tap on a screen whose entire purpose is to be tapped
    // through gets a 429 — and the web, which limits these writes not at all,
    // becomes strictly better at the thing both surfaces are for.
    expect(API_V1_INBOX_STATE_USER_LIMIT.maxPerMinute ?? 0).toBeGreaterThan(
      API_V1_AUTHENTICATED_WRITE_USER_LIMIT.maxPerMinute ?? 0,
    );
  });
});

describe("/api/v1 rate-limit families — the method fence covers every family", () => {
  it("classifies every non-route-local family as read-only or write-only", () => {
    // THE FENCE'S OWN BLIND SPOT, closed. The method check above skips any family
    // that is in neither READ_FAMILIES nor WRITE_FAMILIES — so a family added to
    // the union and forgotten in those two lists is silently exempt from the
    // check that catches a write route wearing a read ceiling. That is the very
    // defect this describe block was extended to catch, reintroduced one level up
    // by omission.
    //
    // `API_V1_IP_FAMILIES` is complete by construction (a `satisfies` in
    // api-v1-limits.ts fails the build if a member is missing), which is what
    // makes this assertion mean something.
    const unclassified = API_V1_IP_FAMILIES.filter(
      (family) =>
        family !== "route-local" &&
        !READ_FAMILIES.includes(family) &&
        !WRITE_FAMILIES.includes(family),
    );
    expect(
      unclassified,
      "a family in neither list is exempt from the read/write direction check — " +
        "add it to READ_FAMILIES or WRITE_FAMILIES",
    ).toEqual([]);
  });

  it("never puts a family in both lists", () => {
    const both = API_V1_IP_FAMILIES.filter(
      (family) => READ_FAMILIES.includes(family) && WRITE_FAMILIES.includes(family),
    );
    expect(both).toEqual([]);
  });

  it("keeps route-local EMPTY, so it cannot become the next `pre-cgnat`", () => {
    // THE RATCHET, and the reason the family was renamed rather than deleted.
    // `familyFromCeiling` returns `route-local` for any ceiling that is not one of
    // this repo's shared constants, so the family has to exist — it is what a
    // route hands the limiter when it owns its own number. What it must never
    // again be is a PLACE TO PUT ONE: `pre-cgnat` held ten buckets for two days
    // and every one of them read as "somebody decided" while being a route nobody
    // had re-derived. Filing a bucket here would pass both set assertions and the
    // ceiling assertion, because a route-local ceiling really does imply
    // `route-local` — which is precisely why the emptiness has to be its own line.
    //
    // A new route with its own literal now fails "declares a family for every
    // per-IP bucket"; a new route ADDED to the map as `route-local` fails here.
    // The fix for both is a family and a derivation in api-v1-limits.ts.
    const filed = Object.entries(API_V1_IP_BUCKET_FAMILIES)
      .filter(([, family]) => family === "route-local")
      .map(([bucket]) => bucket);
    expect(
      filed,
      "a per-IP bucket filed as `route-local` is a route running a ceiling nobody " +
        "derived — give it a family and a derivation in lib/infra/api-v1-limits.ts",
    ).toEqual([]);
  });
});
